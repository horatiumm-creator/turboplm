/**
 * Vendor catalog parsing and mapping (rules V1–V5).
 *
 * Pure logic: no HTTP handling and no database access. The router stages rows, resolves
 * UPDATE/DUPLICATE against the database and writes; everything decidable from the file
 * alone lives here, so the part of the import that is easy to get subtly wrong can be
 * reasoned about — and tested — without a database.
 */
import { CatalogFormat, PartCategory } from '@prisma/client';
import { HttpError } from './errors';

// ---------------------------------------------------------------------------
// Local DTO shapes (must match frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

export type CatalogTargetField =
  | 'partNumber'
  | 'name'
  | 'description'
  | 'category'
  | 'uom'
  | 'unitCost'
  | 'manufacturerName'
  | 'mpn'
  | 'distributorName'
  | 'distributorPartNumber';

export interface CatalogMappedRow {
  partNumber: string | null;
  name: string | null;
  description: string | null;
  category: string | null;
  uom: string | null;
  unitCost: number | null;
  manufacturerName: string | null;
  mpn: string | null;
  distributorName: string | null;
  distributorPartNumber: string | null;
}

/** target field -> source column name (partial: unmapped targets are absent). */
export type CatalogFieldMap = Partial<Record<CatalogTargetField, string>>;

/** Every mappable target, in the order the mapping UI should offer them. */
export const CATALOG_TARGET_FIELDS: CatalogTargetField[] = [
  'partNumber',
  'name',
  'description',
  'category',
  'uom',
  'unitCost',
  'manufacturerName',
  'mpn',
  'distributorName',
  'distributorPartNumber',
];

/** The two targets without which a row describes nothing importable (rule V3). */
export const REQUIRED_TARGET_FIELDS: CatalogTargetField[] = ['name', 'mpn'];

export interface ParsedCatalogFile {
  format: CatalogFormat;
  /** Source column names in file order — what the mapping UI offers. */
  columns: string[];
  /** Data rows verbatim, keyed by column name. Blank records are dropped. */
  rows: Record<string, string>[];
}

// ---------------------------------------------------------------------------
// Text decoding
// ---------------------------------------------------------------------------

/**
 * Bytes -> string, honouring the two encodings real exports actually arrive in besides
 * UTF-8: Excel's "Unicode Text" (UTF-16 with a BOM) and latin-1 BMEcat from EU wholesalers.
 * Guessing wrong is not a cosmetic problem — a UTF-16 file read as UTF-8 produces
 * NUL-riddled headers that match no mapping, and the user gets an inexplicable import.
 */
function decodeText(buffer: Buffer, declaredEncoding?: string): string {
  if (buffer.length >= 2) {
    const [b0, b1] = [buffer[0], buffer[1]];
    if (b0 === 0xff && b1 === 0xfe) return buffer.subarray(2).toString('utf16le');
    if (b0 === 0xfe && b1 === 0xff) {
      // Node has no utf16be decoder; byte-swapping a copy is the whole conversion. The copy
      // matters because swap16 mutates in place and the caller still owns the upload buffer.
      const body = buffer.subarray(2);
      const even = body.length % 2 === 0 ? body : body.subarray(0, body.length - 1);
      return Buffer.from(even).swap16().toString('utf16le');
    }
  }
  if (declaredEncoding !== undefined && LATIN1_ENCODINGS.has(declaredEncoding.toLowerCase())) {
    // windows-1252 is treated as latin-1: they differ only in 0x80–0x9F (curly quotes and
    // the euro sign), which is a wrong glyph rather than a wrong import.
    return buffer.toString('latin1');
  }
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const LATIN1_ENCODINGS = new Set([
  'iso-8859-1',
  'iso8859-1',
  'latin1',
  'latin-1',
  'windows-1252',
  'cp1252',
]);

// ---------------------------------------------------------------------------
// Delimited text (CSV/TSV) — RFC 4180
// ---------------------------------------------------------------------------

/** Sniffed in this order, so a genuine tie goes to the comma. */
const DELIMITER_CANDIDATES = [',', ';', '\t', '|'];

/** Excel writes this directive as the first line to force a delimiter on the reader. */
const SEP_DIRECTIVE = /^sep=(.)\r?\n/i;

/** Enough to hold any realistic header record, including a quoted one spanning lines. */
const SNIFF_BYTES = 64 * 1024;

/**
 * Pick the delimiter by parsing a sample with each candidate and comparing how many fields
 * the header record yields.
 *
 * Counting delimiter characters in the raw text cannot agree with the reader below, and the
 * two disagreements were both silent data loss rather than an error:
 *   - which record is the header — a leading blank or whitespace-only line made the count
 *     run on that line, find no delimiters and fall back to ",", collapsing a semicolon
 *     export into a single column;
 *   - when a quote opens a field — a character scan flips into quote mode on a mid-field
 *     quote, so a perfectly ordinary header like `Groesse 3/4"` sent it scanning past the
 *     header into the data rows.
 * Sniffing *through* the reader makes agreement structural instead of a thing to maintain
 * in two places.
 */
function sniffDelimiter(text: string): string {
  const sample = text.length > SNIFF_BYTES ? text.slice(0, SNIFF_BYTES) : text;
  let best = DELIMITER_CANDIDATES[0];
  let bestFields = 0;
  for (const candidate of DELIMITER_CANDIDATES) {
    const header = parseDelimitedRecords(sample, candidate).find(
      (fields) => !isBlankRecord(fields)
    );
    const fields = header?.length ?? 0;
    // Strictly greater, so the candidate order decides ties and a comma still wins.
    if (fields > bestFields) {
      best = candidate;
      bestFields = fields;
    }
  }
  return best;
}

/**
 * RFC 4180 reader: quoted fields may contain the delimiter, newlines and doubled quotes;
 * CRLF, LF and a lone CR all end a record. A quote appearing inside an unquoted field is
 * kept literally rather than rejected — hand-written exports do that and refusing the whole
 * file over one stray quote helps nobody.
 */
function parseDelimitedRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '' && !quotedField) {
      inQuotes = true;
      quotedField = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      record.push(field);
      field = '';
      quotedField = false;
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      record.push(field);
      field = '';
      quotedField = false;
      records.push(record);
      record = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  record.push(field);
  records.push(record);
  return records;
}

function isBlankRecord(fields: string[]): boolean {
  return fields.every((f) => f.trim() === '');
}

/**
 * Column names must be unique and non-empty to key a row object. Blank and repeated headers
 * are renamed rather than dropped, because the data underneath them is still the user's and
 * silently losing a column is worse than an ugly name.
 */
function columnNames(header: string[]): string[] {
  const used = new Set<string>();
  return header.map((raw, index) => {
    const trimmed = raw.trim();
    let name = trimmed === '' ? `Column ${index + 1}` : trimmed;
    if (used.has(name)) {
      let suffix = 2;
      while (used.has(`${name} (${suffix})`)) suffix += 1;
      name = `${name} (${suffix})`;
    }
    used.add(name);
    return name;
  });
}

function tableFromRecords(records: string[][]): { columns: string[]; rows: Record<string, string>[] } {
  const headerIndex = records.findIndex((fields) => !isBlankRecord(fields));
  if (headerIndex === -1) throw new HttpError(400, 'The file has no data rows');

  const columns = columnNames(records[headerIndex]);
  const rows: Record<string, string>[] = [];
  for (const fields of records.slice(headerIndex + 1)) {
    if (isBlankRecord(fields)) continue;
    const row: Record<string, string> = {};
    // Values stay verbatim (rule V2 stores the source row as-is); short rows leave the
    // missing columns empty, extra fields have no column to belong to and are dropped.
    columns.forEach((name, index) => {
      row[name] = fields[index] ?? '';
    });
    rows.push(row);
  }
  if (rows.length === 0) throw new HttpError(400, 'The file has no data rows');
  return { columns, rows };
}

function parseDelimitedFile(buffer: Buffer): ParsedCatalogFile {
  let text = decodeText(buffer);
  const directive = SEP_DIRECTIVE.exec(text);
  let delimiter: string;
  if (directive) {
    delimiter = directive[1];
    text = text.slice(directive[0].length);
  } else {
    delimiter = sniffDelimiter(text);
  }
  const { columns, rows } = tableFromRecords(parseDelimitedRecords(text, delimiter));
  return { format: CatalogFormat.CSV, columns, rows };
}

// ---------------------------------------------------------------------------
// BMEcat XML
// ---------------------------------------------------------------------------

/** The flattened columns a BMEcat ARTICLE is reduced to, in mapping-UI order. */
const BMECAT_COLUMNS = [
  'SUPPLIER_AID',
  'MANUFACTURER_AID',
  'MANUFACTURER_NAME',
  'DESCRIPTION_SHORT',
  'DESCRIPTION_LONG',
  'EAN',
  'ORDER_UNIT',
  'PRICE_AMOUNT',
];

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** The five predefined entities plus numeric references; unknown names are left alone. */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return XML_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** `<ns:DESCRIPTION_SHORT>` and `<DESCRIPTION_SHORT>` are the same tag to this reader. */
function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return (colon === -1 ? qualified : qualified.slice(colon + 1)).toUpperCase();
}

/**
 * Index of the `>` closing the tag that starts at `from`, skipping any `>` inside a quoted
 * attribute value. Scanning rather than pattern-matching is what makes this reader
 * indifferent to attribute count, order and content.
 */
function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let i = from + 1; i < xml.length; i += 1) {
    const ch = xml[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

/** Skip `<!DOCTYPE …>` including an internal subset, and any other `<!…>` declaration. */
function skipDeclaration(xml: string, from: number): number {
  let depth = 0;
  for (let i = from + 2; i < xml.length; i += 1) {
    const ch = xml[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    else if (ch === '>' && depth <= 0) return i + 1;
  }
  return xml.length;
}

interface XmlTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Index just past the tag. */
  next: number;
}

function readTag(xml: string, lt: number): XmlTag | null {
  const gt = findTagEnd(xml, lt);
  if (gt === -1) return null;
  const body = xml.slice(lt + 1, gt);
  const closing = body.startsWith('/');
  const selfClosing = !closing && body.endsWith('/');
  const inner = closing ? body.slice(1) : selfClosing ? body.slice(0, -1) : body;
  const name = localName(inner.trim().split(/[\s/]/)[0] ?? '');
  return { name, closing, selfClosing, next: gt + 1 };
}

/** Local name of the root element, ignoring the prolog, comments and the doctype. */
function rootElementName(xml: string): string | null {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) return null;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt);
      i = end === -1 ? xml.length : end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      i = skipDeclaration(xml, lt);
      continue;
    }
    const tag = readTag(xml, lt);
    return tag ? tag.name : null;
  }
  return null;
}

/**
 * Narrow BMEcat reader: one pass over the document collecting the eight flattened fields
 * from every `<ARTICLE>`.
 *
 * Supports: any BMEcat version that spells these tags this way (1.2 and 2005 both do),
 * namespace prefixes, arbitrary attributes, self-closing tags, CDATA, comments, the
 * doctype, entity references, and markup nested inside a captured tag (its text is kept,
 * its tags are ignored).
 *
 * Does NOT support: XPath-style placement — a wanted tag is taken wherever it appears
 * inside the ARTICLE, so a `MANUFACTURER_NAME` under some other sub-element would be read
 * as the article's; only the first occurrence of each tag is kept, so tiered
 * `ARTICLE_PRICE_DETAILS` collapse to the first `PRICE_AMOUNT`; `EAN` is read only when the
 * tag is literally named EAN (BMEcat 2005's `INTERNATIONAL_PID` is ignored); ETIM feature
 * blocks, MIME/document references and price currencies/tax are not extracted. Anything
 * richer needs a real BMEcat library, not this.
 */
function readBmecatArticles(xml: string): Record<string, string>[] {
  const wanted = new Set(BMECAT_COLUMNS);
  const rows: Record<string, string>[] = [];
  let article: Record<string, string> | null = null;
  // ARTICLE nesting is not expected, but counting depth means an unexpected nested one
  // cannot silently start a second record and lose the outer article's fields.
  let articleDepth = 0;
  let capture: string | null = null;
  let captureDepth = 0;
  let text = '';
  let i = 0;

  const blankArticle = (): Record<string, string> => {
    const row: Record<string, string> = {};
    for (const column of BMECAT_COLUMNS) row[column] = '';
    return row;
  };

  const finishArticle = (): void => {
    if (article !== null) rows.push(article);
    article = null;
    capture = null;
    captureDepth = 0;
    text = '';
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (capture !== null) text += decodeEntities(xml.slice(i, lt));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      const stop = end === -1 ? xml.length : end;
      // CDATA is literal by definition: no entity decoding, or "&amp;" in a description
      // would silently become "&".
      if (capture !== null) text += xml.slice(lt + 9, stop);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt);
      i = end === -1 ? xml.length : end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      i = skipDeclaration(xml, lt);
      continue;
    }

    const tag = readTag(xml, lt);
    if (!tag) break;
    i = tag.next;

    if (tag.closing) {
      if (capture !== null && tag.name === capture) {
        if (captureDepth > 0) {
          captureDepth -= 1;
        } else {
          if (article !== null) article[capture] = text.trim();
          capture = null;
          text = '';
        }
        continue;
      }
      if (tag.name === 'ARTICLE' && articleDepth > 0) {
        articleDepth -= 1;
        if (articleDepth === 0) finishArticle();
      }
      continue;
    }

    if (capture !== null) {
      // Markup inside a captured tag: keep the text, ignore the tag — except a same-named
      // nesting, which must not let the inner close end the outer capture.
      if (tag.name === capture && !tag.selfClosing) captureDepth += 1;
      continue;
    }

    if (tag.name === 'ARTICLE') {
      if (articleDepth === 0) article = blankArticle();
      articleDepth += 1;
      if (tag.selfClosing) {
        articleDepth -= 1;
        if (articleDepth === 0) finishArticle();
      }
      continue;
    }

    // First occurrence wins, so a repeated tag (tiered prices) cannot overwrite it.
    if (article !== null && !tag.selfClosing && wanted.has(tag.name) && article[tag.name] === '') {
      capture = tag.name;
      captureDepth = 0;
      text = '';
    }
  }
  // An unterminated last ARTICLE still describes a product; keep it rather than dropping
  // data because the file was truncated.
  if (articleDepth > 0) finishArticle();
  return rows;
}

const XML_DECLARED_ENCODING = /encoding\s*=\s*["']([^"']+)["']/;

function parseBmecatFile(buffer: Buffer): ParsedCatalogFile {
  // The declaration is ASCII in every encoding we support, so it is safe to read it from a
  // provisional latin-1 decode of the prolog before choosing the real decoder.
  const prolog = buffer.subarray(0, 256).toString('latin1');
  const declared = XML_DECLARED_ENCODING.exec(prolog);
  const xml = decodeText(buffer, declared ? declared[1] : undefined);

  // Rule V2 detects XML by its root: an XML file that is not a BMEcat catalog is a file
  // type this importer does not handle, and saying so beats mapping zero columns.
  if (rootElementName(xml) !== 'BMECAT') throw new HttpError(400, 'Unsupported file type');

  const rows = readBmecatArticles(xml);
  if (rows.length === 0) throw new HttpError(400, 'The file has no data rows');
  // Every column is offered even when this particular file leaves one empty throughout, so
  // a saved BMEcat mapping keeps working across catalogs.
  return { format: CatalogFormat.BMECAT_XML, columns: [...BMECAT_COLUMNS], rows };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * No XLSX reader is available: neither `xlsx` nor `exceljs` is a dependency of this backend
 * and a catalog importer is not a reason to add one. XLSX is still accepted by the upload
 * rule (V2), so the failure has to explain the way out rather than say "unsupported".
 */
const XLSX_UNSUPPORTED =
  'XLSX files cannot be read by this server — open the workbook and save it as CSV, then upload that';

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function parseCatalogFile(buffer: Buffer, fileName: string): ParsedCatalogFile {
  switch (fileExtension(fileName)) {
    case 'csv':
    case 'tsv':
      // TSV is CSV with a tab; the sniffer finds it, and CatalogFormat has no TSV member.
      return parseDelimitedFile(buffer);
    case 'xlsx':
      throw new HttpError(400, XLSX_UNSUPPORTED);
    case 'xml':
      return parseBmecatFile(buffer);
    default:
      throw new HttpError(400, 'Unsupported file type');
  }
}

// ---------------------------------------------------------------------------
// Built-in mappings and vendor detection
// ---------------------------------------------------------------------------

export interface BuiltInMapping {
  name: string;
  vendor: string | null;
  format: CatalogFormat;
  fieldMap: CatalogFieldMap;
  /** Values these exports carry nowhere in the file; null when nothing has to be supplied. */
  defaults: CatalogFieldMap | null;
  headerSignature: string[];
}

/**
 * The five seeded presets (rule V5).
 *
 * `headerSignature` is the vendor's own part-number column plus the manufacturer part
 * number: the smallest set that cannot collide between these four distributors while
 * surviving the optional columns they add and drop between export versions.
 *
 * No preset maps `partNumber`: an internal part number is ours to generate, not the
 * distributor's to dictate. Nor does any distributor preset map `unitCost` — the price
 * column is named differently in every export flavour ("Unit Price", "Price (USD)",
 * "Price Each"), and a guessed column silently maps nothing while looking authoritative.
 * The mapping step shows sample rows precisely so the user can point at it in one click.
 */
export const BUILT_IN_MAPPINGS: BuiltInMapping[] = [
  {
    name: 'Digi-Key CSV export',
    vendor: 'Digi-Key',
    format: CatalogFormat.CSV,
    fieldMap: {
      name: 'Description',
      manufacturerName: 'Manufacturer',
      mpn: 'Manufacturer Part Number',
      distributorPartNumber: 'Digi-Key Part Number',
    },
    // The distributor is the file's identity, never one of its columns.
    defaults: { category: 'PURCHASED', distributorName: 'Digi-Key' },
    headerSignature: ['Digi-Key Part Number', 'Manufacturer Part Number'],
  },
  {
    name: 'Mouser CSV export',
    vendor: 'Mouser',
    format: CatalogFormat.CSV,
    fieldMap: {
      name: 'Description',
      manufacturerName: 'Manufacturer Name',
      mpn: 'Mfr. Part Number',
      distributorPartNumber: 'Mouser Part Number',
    },
    defaults: { category: 'PURCHASED', distributorName: 'Mouser' },
    headerSignature: ['Mouser Part Number', 'Mfr. Part Number'],
  },
  {
    name: 'Farnell / Newark CSV export',
    vendor: 'Farnell / Newark',
    format: CatalogFormat.CSV,
    fieldMap: {
      name: 'Description',
      manufacturerName: 'Manufacturer',
      mpn: 'Manufacturer Part Number',
      distributorPartNumber: 'Order Code',
    },
    defaults: { category: 'PURCHASED', distributorName: 'Farnell / Newark' },
    headerSignature: ['Order Code', 'Manufacturer Part Number'],
  },
  {
    name: 'RS Components CSV export',
    vendor: 'RS Components',
    format: CatalogFormat.CSV,
    fieldMap: {
      name: 'Description',
      manufacturerName: 'Manufacturer',
      mpn: 'Manufacturer Part Number',
      distributorPartNumber: 'RS Stock No.',
    },
    defaults: { category: 'PURCHASED', distributorName: 'RS Components' },
    headerSignature: ['RS Stock No.', 'Manufacturer Part Number'],
  },
  {
    // Not a vendor — a standard. Its "columns" are the tags the reader flattens ARTICLE to,
    // so the signature identifies the format and `detectVendor` stays silent for it.
    name: 'BMEcat 5.0 (ETIM)',
    vendor: null,
    format: CatalogFormat.BMECAT_XML,
    fieldMap: {
      name: 'DESCRIPTION_SHORT',
      description: 'DESCRIPTION_LONG',
      manufacturerName: 'MANUFACTURER_NAME',
      mpn: 'MANUFACTURER_AID',
      uom: 'ORDER_UNIT',
      unitCost: 'PRICE_AMOUNT',
      distributorPartNumber: 'SUPPLIER_AID',
    },
    defaults: { category: 'PURCHASED' },
    headerSignature: ['SUPPLIER_AID', 'MANUFACTURER_AID'],
  },
];

/**
 * Column keys match ignoring case, surrounding and internal whitespace, and punctuation.
 * Real exports differ from their own documentation by exactly this much — "Digi-Key Part
 * Number" vs "DigiKey Part Number", "Mfr. Part Number" vs "Mfr Part Number" — and failing
 * to detect a vendor over a missing hyphen would make auto-detection useless.
 */
function normalizeColumnKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function columnKeySet(columns: string[]): Set<string> {
  const keys = new Set<string>();
  for (const column of columns) {
    const key = normalizeColumnKey(column);
    if (key !== '') keys.add(key);
  }
  return keys;
}

/** True when every column of `signature` is present in `columns`. */
export function matchesHeaderSignature(columns: string[], signature: string[]): boolean {
  if (signature.length === 0) return false;
  const keys = columnKeySet(columns);
  return signature.every((column) => keys.has(normalizeColumnKey(column)));
}

/**
 * Vendor signatures, derived from the presets so the two can never drift apart. Newark is
 * the North-American storefront of the Farnell catalog and exports the same rows under its
 * own part-number column, which a single AND-signature cannot express — hence the extra
 * entry pointing at the same vendor.
 */
const VENDOR_SIGNATURES: { vendor: string; signature: string[] }[] = [
  ...BUILT_IN_MAPPINGS.filter(
    (mapping): mapping is BuiltInMapping & { vendor: string } =>
      mapping.vendor !== null && mapping.headerSignature.length > 0
  ).map((mapping) => ({ vendor: mapping.vendor, signature: mapping.headerSignature })),
  { vendor: 'Farnell / Newark', signature: ['Newark Part Number', 'Manufacturer Part Number'] },
];

export function detectVendor(columns: string[]): { vendor: string; signature: string[] } | null {
  const keys = columnKeySet(columns);
  // Most specific first, so a file matching two signatures gets the better-evidenced vendor.
  const ordered = [...VENDOR_SIGNATURES].sort((a, b) => b.signature.length - a.signature.length);
  for (const candidate of ordered) {
    if (candidate.signature.every((column) => keys.has(normalizeColumnKey(column)))) {
      return { vendor: candidate.vendor, signature: [...candidate.signature] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Units of measure this PLM understands, each with the spellings catalogs actually use —
 * including the UN/ECE Rec 20 codes BMEcat carries (C62, MTR, KGM …), which would otherwise
 * make every EU catalog row invalid.
 */
const UOM_ALIASES: Record<string, string[]> = {
  ea: ['ea', 'each', 'pc', 'pcs', 'pce', 'piece', 'pieces', 'unit', 'units', 'item', 'stk', 'stuck', 'c62', 'h87'],
  set: ['set', 'sets', 'satz'],
  pair: ['pair', 'pairs', 'pr', 'npr'],
  kit: ['kit', 'kits'],
  box: ['box', 'boxes', 'bx', 'bx1', 'karton'],
  pack: ['pack', 'packs', 'pk', 'pa', 'packet'],
  reel: ['reel', 'reels', 'rl'],
  roll: ['roll', 'rolls', 'ro', 'rolle'],
  sheet: ['sheet', 'sheets', 'sh', 'st'],
  m: ['m', 'mtr', 'meter', 'metre', 'meters', 'metres'],
  cm: ['cm', 'cmt', 'centimeter', 'centimetre'],
  mm: ['mm', 'mmt', 'millimeter', 'millimetre'],
  in: ['in', 'inh', 'inch', 'inches'],
  ft: ['ft', 'fot', 'foot', 'feet'],
  m2: ['m2', 'mtk', 'sqm', 'squaremeter', 'squaremetre'],
  cm2: ['cm2', 'cmk'],
  mm2: ['mm2', 'mmk'],
  m3: ['m3', 'mtq', 'cbm', 'cubicmeter'],
  l: ['l', 'ltr', 'liter', 'litre', 'liters', 'litres'],
  ml: ['ml', 'mlt'],
  gal: ['gal', 'gll', 'gallon', 'gallons'],
  kg: ['kg', 'kgm', 'kilo', 'kilogram', 'kilograms'],
  g: ['g', 'grm', 'gram', 'grams'],
  mg: ['mg', 'mgm'],
  lb: ['lb', 'lbs', 'lbr', 'pound', 'pounds'],
  oz: ['oz', 'onz', 'ounce', 'ounces'],
  hr: ['hr', 'hrs', 'hur', 'hour', 'hours'],
  min: ['min', 'mins', 'minute', 'minutes'],
};

const UOM_BY_ALIAS = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(UOM_ALIASES)) {
  for (const alias of aliases) UOM_BY_ALIAS.set(alias, canonical);
}

/** The canonical units, for a caller that wants to show the user what is accepted. */
export const CATALOG_UOMS: string[] = Object.keys(UOM_ALIASES);

function normalizeUomKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/[^a-z0-9]/g, '');
}

/** Canonical unit, or null when the value is not one this PLM knows. */
function canonicalUom(value: string): string | null {
  return UOM_BY_ALIAS.get(normalizeUomKey(value)) ?? null;
}

/** Catalogs spell enums loosely — "raw material" and "Raw-Material" are RAW_MATERIAL. */
function canonicalCategory(value: string): string | null {
  const key = value.toUpperCase().replace(/[\s-]+/g, '_');
  return (Object.values(PartCategory) as string[]).includes(key) ? key : null;
}

/** One run of digits and separators (".56" counts), with currency noise allowed on either
 * side but no second number: "2 for 5.00" is not a price this importer will guess at. */
const PRICE_CORE = /^[^0-9.,]*((?:[0-9]|[.,][0-9])[0-9.,]*)[^0-9]*$/;

/**
 * `unitCost` from a human-written price cell.
 *
 * Currency symbols and codes, per-unit suffixes and grouping whitespace (including NBSP)
 * are stripped; parentheses or a leading minus mean negative. What remains must be a single
 * run of digits and separators, read as follows:
 *   - both `.` and `,` present -> the last one is the decimal separator and the other must
 *     group by threes: "$1,234.56" -> 1234.56, "1.234,56" -> 1234.56
 *   - one kind, repeated -> grouping: "1.234.567" -> 1234567
 *   - a single `.` -> decimal point: "0.1234" -> 0.1234. Electronics unit prices routinely
 *     carry three or four decimals, so this reading is far more often right than reading
 *     "1.234" as German for 1234
 *   - a single `,` with 1, 2 or 4+ following digits -> decimal comma ("12,5" -> 12.5): a
 *     thousands group is always exactly three digits, so this cannot be grouping
 *   - a single `,` with exactly three following digits -> AMBIGUOUS. "1,234" is 1234 to a
 *     US export and 1.234 to a German one, with no evidence either way, so it is refused
 *     rather than guessed 1000x wrong
 * A cell with no digits at all ("N/A", "-", "Call") means "no price", not "bad number", and
 * yields null. A cell with digits that does not parse yields NaN — see `mapUnitCost`.
 */
function parseUnitCost(text: string): number | null {
  if (!/[0-9]/.test(text)) return null;
  // \s already covers NBSP and the narrow no-break space EU exports group thousands with.
  const spaced = text.replace(/\s+/g, ' ').trim();
  const negative = /^\(.*\)$/.test(spaced) || spaced.startsWith('-');
  // Space-grouped thousands ("1 234 567,89") are joined up first; any other space between
  // digits is two numbers in one cell, which the core pattern then refuses.
  const compact = spaced.replace(/(\d) (?=\d{3}(?:\D|$))/g, '$1');
  const core = PRICE_CORE.exec(compact);
  if (!core) return Number.NaN;
  const cleaned = core[1];

  const dots = (cleaned.match(/\./g) ?? []).length;
  const commas = (cleaned.match(/,/g) ?? []).length;

  let decimalSeparator = '';
  if (dots > 0 && commas > 0) {
    decimalSeparator = cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',') ? '.' : ',';
  } else if (dots === 1 && commas === 0) {
    decimalSeparator = '.';
  } else if (commas === 1 && dots === 0) {
    const decimals = cleaned.length - cleaned.indexOf(',') - 1;
    if (decimals === 3) return Number.NaN;
    decimalSeparator = ',';
  }

  let groupSeparator = '';
  if (decimalSeparator === '.') groupSeparator = ',';
  else if (decimalSeparator === ',') groupSeparator = '.';
  else if (dots > 1) groupSeparator = '.';
  else if (commas > 1) groupSeparator = ',';

  let integerPart = cleaned;
  let fractionPart = '';
  if (decimalSeparator !== '') {
    const at = cleaned.lastIndexOf(decimalSeparator);
    integerPart = cleaned.slice(0, at);
    fractionPart = cleaned.slice(at + 1);
    if (!/^[0-9]+$/.test(fractionPart)) return Number.NaN;
  }
  const groups = groupSeparator === '' ? [integerPart] : integerPart.split(groupSeparator);
  if (groups.some((group) => !/^[0-9]*$/.test(group))) return Number.NaN;
  // Grouping must be exactly three digits per group after the first, or this is not a
  // number we understand ("12,34,567" is not something to guess at).
  if (groups.length > 1) {
    if (groups[0] === '' || groups[0].length > 3) return Number.NaN;
    if (groups.slice(1).some((group) => group.length !== 3)) return Number.NaN;
  }
  const digits = groups.join('');
  if (digits === '' && fractionPart === '') return Number.NaN;
  const value = Number(`${digits === '' ? '0' : digits}.${fractionPart === '' ? '0' : fractionPart}`);
  if (!Number.isFinite(value)) return Number.NaN;
  return negative ? -value : value;
}

/**
 * Resolve a source value: the mapped column, falling back to the mapping's default for
 * fields the file does not carry. An absent column and an empty cell are the same thing —
 * both mean "the file did not say".
 */
function sourceValue(
  raw: Record<string, string>,
  columnIndex: Map<string, string>,
  fieldMap: CatalogFieldMap,
  defaults: CatalogFieldMap | null | undefined,
  field: CatalogTargetField
): string {
  const column = fieldMap[field];
  let value = '';
  if (column !== undefined) {
    const exact = raw[column];
    if (exact !== undefined) {
      value = exact.trim();
    } else {
      // A mapping saved from one export is re-applied to the next, where a column may have
      // gained a space or changed case; match it rather than dropping the field.
      const key = columnIndex.get(normalizeColumnKey(column));
      value = key === undefined ? '' : (raw[key] ?? '').trim();
    }
  }
  if (value === '' && defaults) value = (defaults[field] ?? '').trim();
  return value;
}

/**
 * `unitCost` needs a third state the wire shape has no room for: absent (null, legal),
 * a number, and "present but unreadable" (INVALID per rule V3). NaN carries the third one
 * to `classifyRow`; it is the only value that must not be interpreted as a cost. Storing
 * the mapped row as JSON turns it into null, which is the right thing to persist — the row
 * is already INVALID and carries the message explaining why.
 */
function mapUnitCost(text: string): number | null {
  if (text === '') return null;
  return parseUnitCost(text);
}

export function applyMapping(
  raw: Record<string, string>,
  fieldMap: CatalogFieldMap,
  defaults?: CatalogFieldMap | null
): CatalogMappedRow {
  const columnIndex = new Map<string, string>();
  for (const column of Object.keys(raw)) {
    const key = normalizeColumnKey(column);
    if (key !== '' && !columnIndex.has(key)) columnIndex.set(key, column);
  }
  const value = (field: CatalogTargetField): string =>
    sourceValue(raw, columnIndex, fieldMap, defaults, field);
  const orNull = (field: CatalogTargetField): string | null => {
    const text = value(field);
    return text === '' ? null : text;
  };

  const categoryText = value('category');
  const uomText = value('uom');
  return {
    partNumber: orNull('partNumber'),
    name: orNull('name'),
    description: orNull('description'),
    // Loose spellings are canonicalized; an unrecognized value is kept as written so the
    // INVALID message can quote what the user actually has in the file.
    category: categoryText === '' ? null : (canonicalCategory(categoryText) ?? categoryText),
    uom: uomText === '' ? null : (canonicalUom(uomText) ?? uomText),
    unitCost: mapUnitCost(value('unitCost')),
    manufacturerName: orNull('manufacturerName'),
    mpn: orNull('mpn'),
    distributorName: orNull('distributorName'),
    distributorPartNumber: orNull('distributorPartNumber'),
  };
}

// ---------------------------------------------------------------------------
// Row classification (the INVALID checks only)
// ---------------------------------------------------------------------------

export type RowClassification = { ok: true } | { ok: false; message: string };

/**
 * The file-only half of rule V3's step 1. DUPLICATE and UPDATE need the database and the
 * rows before this one, so they stay in the router.
 *
 * Every problem is reported in one message rather than the first one only: re-validating a
 * 5,000-row import to discover the next complaint is a waste of the user's afternoon. The
 * checks are deliberately limited to what V3 lists — a catalog part number that would look
 * odd is still the user's choice, and inventing extra rejections here would reject imports
 * the contract accepts.
 */
export function classifyRow(mapped: CatalogMappedRow): RowClassification {
  const problems: string[] = [];

  for (const field of REQUIRED_TARGET_FIELDS) {
    if (mapped[field] === null) problems.push(`${field} is required`);
  }
  if (mapped.unitCost !== null) {
    if (Number.isNaN(mapped.unitCost)) problems.push('unitCost is not a number');
    else if (mapped.unitCost < 0) problems.push('unitCost must not be negative');
  }
  if (mapped.category !== null && canonicalCategory(mapped.category) === null) {
    problems.push(
      `category "${mapped.category}" is not one of ${Object.values(PartCategory).join(', ')}`
    );
  }
  if (mapped.uom !== null && canonicalUom(mapped.uom) === null) {
    problems.push(`uom "${mapped.uom}" is not a recognized unit of measure`);
  }

  return problems.length === 0 ? { ok: true } : { ok: false, message: problems.join('; ') };
}
