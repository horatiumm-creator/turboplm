import { Request, Response, Router } from 'express';
import { AmlStatus, Lifecycle, PartCategory, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter, assertCanWrite, REDACTED, visibleIds } from '../lib/acl';

const router = Router();

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (ImportResult / ImportIssue mirror
// frontend/src/api/types.ts exactly; the export rows are ERP-facing rows that
// serialize identically in CSV and JSON — "blank when none" is an empty string)
// ---------------------------------------------------------------------------

interface ErpItemDto {
  partNumber: string;
  name: string;
  category: PartCategory;
  uom: string;
  unitCost: number | null;
  /** Label of the newest RELEASED revision; blank when the part has none. */
  releasedRevision: string;
  /** Lifecycle of the newest revision; blank when the part has no revisions. */
  lifecycle: Lifecycle | '';
  /** MPN/manufacturer of the PREFERRED AML entry; blank when there is none. */
  preferredMpn: string;
  manufacturer: string;
}

interface ErpBomRowDto {
  parentPartNumber: string;
  findNumber: number;
  childPartNumber: string;
  quantity: number;
  uom: string;
  refDesignators: string;
}

interface ImportIssueDto {
  row: number;
  message: string;
}

interface ImportResultDto {
  dryRun: boolean;
  parsed: number;
  created: number;
  updated: number;
  skipped: number;
  issues: ImportIssueDto[];
}

// ---------------------------------------------------------------------------
// CSV writing — same quoting/neutralization approach as bom.ts
// ---------------------------------------------------------------------------

/**
 * RFC 4180 quoting plus formula neutralization: cells starting with = + - @ or tab
 * are prefixed with a single quote so spreadsheet apps treat them as text
 * (CSV-injection mitigation; numeric columns never start with those characters).
 */
function csvField(value: string): string {
  const neutralized = /^[=+\-@\t]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',');
}

function sendCsv(res: Response, fileName: string, rows: string[]): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(rows.join('\r\n') + '\r\n');
}

function safeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---------------------------------------------------------------------------
// CSV reading — small RFC 4180 parser (quoted fields may contain commas,
// newlines and doubled quotes; CRLF, LF and lone CR all end a record)
// ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
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
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      record.push(field);
      field = '';
      records.push(record);
      record = [];
      i += ch === '\r' && source[i + 1] === '\n' ? 2 : 1;
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

/** Header keys match case-insensitively and ignore spacing/punctuation. */
function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface CsvRow {
  /** 1-based data row number (blank records consume a number, as in the file). */
  row: number;
  fields: string[];
}

interface CsvTable {
  columns: Map<string, number>;
  rows: CsvRow[];
}

/**
 * Read the header row (required, order-independent, unknown columns ignored)
 * and the data rows. A missing required column is a 400 for the whole request;
 * everything else degrades into per-row issues.
 */
function readCsvTable(csv: string, requiredColumns: string[]): CsvTable {
  const records = parseCsv(csv);
  const headerIndex = records.findIndex((fields) => !isBlankRecord(fields));
  if (headerIndex === -1) throw new HttpError(400, 'CSV is empty — a header row is required');

  const columns = new Map<string, number>();
  records[headerIndex].forEach((header, index) => {
    const key = normalizeHeader(header);
    if (key !== '' && !columns.has(key)) columns.set(key, index);
  });

  const missing = requiredColumns.filter((name) => !columns.has(normalizeHeader(name)));
  if (missing.length > 0) {
    throw new HttpError(400, `CSV is missing required column(s): ${missing.join(', ')}`);
  }

  const rows: CsvRow[] = [];
  records.slice(headerIndex + 1).forEach((fields, index) => {
    if (isBlankRecord(fields)) return;
    rows.push({ row: index + 1, fields });
  });
  return { columns, rows };
}

/**
 * Trimmed cell value; blank for absent columns and short rows ("not supplied").
 *
 * Exports prefix cells starting with = + - @ or tab with an apostrophe so
 * spreadsheets treat them as text (CSV-injection guard). Reverse that here, so
 * an export → edit → re-import round trip preserves values like "-48V Converter"
 * instead of accumulating apostrophes.
 */
function cell(table: CsvTable, row: CsvRow, column: string): string {
  const index = table.columns.get(normalizeHeader(column));
  if (index === undefined) return '';
  const raw = (row.fields[index] ?? '').trim();
  return /^'[=+\-@\t]/.test(raw) ? raw.slice(1) : raw;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function parseImportBody(req: Request): { csv: string; dryRun: boolean } {
  const body = requireBody(req);
  if (typeof body.csv !== 'string' || body.csv.trim() === '') {
    throw new HttpError(400, 'csv is required and must be a non-empty string');
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    throw new HttpError(400, 'dryRun must be a boolean');
  }
  return { csv: body.csv, dryRun: body.dryRun === true };
}

/** Per-row validation result: a usable spec, or the message to report and skip. */
type RowOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

const PART_NUMBER_RE = /^[A-Za-z0-9._-]+$/;

/** ERP feeds spell enums loosely — "raw material" and "Raw-Material" both work. */
function matchCategory(value: string): PartCategory | null {
  const key = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return (Object.values(PartCategory) as string[]).includes(key) ? (key as PartCategory) : null;
}

// Bulk imports do far more work than a normal request; give the write
// transaction room rather than tripping the default 5s interactive limit.
const IMPORT_TX_OPTIONS = { maxWait: 15_000, timeout: 120_000 } as const;

// ---------------------------------------------------------------------------
// GET /erp/items.csv | /erp/items.json — item master
// ---------------------------------------------------------------------------

const ITEM_CSV_HEADER = [
  'Part Number',
  'Name',
  'Category',
  'UoM',
  'Unit Cost',
  'Released Revision',
  'Lifecycle',
  'Preferred MPN',
  'Manufacturer',
];

async function loadItemMaster(user: AclUser): Promise<ErpItemDto[]> {
  // An export is a list: restricted parts are omitted outright (rule X2). The integration
  // identity is the API key creator's — see lib/acl.ts note 13: an admin's key exports as an
  // ENGINEER and does not carry the admin bypass.
  const parts = await prisma.part.findMany({
    where: { ...(aclFilter('PART', user) as Prisma.PartWhereInput) },
    orderBy: { partNumber: 'asc' },
    include: {
      revisions: {
        select: { id: true, revision: true, lifecycle: true },
        orderBy: { id: 'desc' },
      },
      manufacturerParts: {
        where: { status: AmlStatus.PREFERRED },
        select: { mpn: true, manufacturer: { select: { name: true } } },
      },
    },
  });

  return parts.map((part): ErpItemDto => {
    const latest = part.revisions.length > 0 ? part.revisions[0] : null;
    const released = part.revisions.find((rev) => rev.lifecycle === Lifecycle.RELEASED) ?? null;
    // Several AML entries can be PREFERRED; pick deterministically by MPN.
    const preferred = [...part.manufacturerParts].sort((a, b) => a.mpn.localeCompare(b.mpn))[0];
    return {
      partNumber: part.partNumber,
      name: part.name,
      category: part.category,
      uom: part.uom,
      unitCost: part.unitCost,
      releasedRevision: released ? released.revision : '',
      lifecycle: latest ? latest.lifecycle : '',
      preferredMpn: preferred ? preferred.mpn : '',
      manufacturer: preferred ? preferred.manufacturer.name : '',
    };
  });
}

router.get(
  '/erp/items.csv',
  asyncHandler(async (req, res) => {
    const items = await loadItemMaster(aclUser(req));
    const rows = [csvRow(ITEM_CSV_HEADER)];
    for (const item of items) {
      rows.push(
        csvRow([
          item.partNumber,
          item.name,
          item.category,
          item.uom,
          item.unitCost === null ? '' : String(item.unitCost),
          item.releasedRevision,
          item.lifecycle,
          item.preferredMpn,
          item.manufacturer,
        ])
      );
    }
    sendCsv(res, 'erp_items.csv', rows);
  })
);

router.get(
  '/erp/items.json',
  asyncHandler(async (req, res) => {
    const items = await loadItemMaster(aclUser(req));
    res.setHeader('Content-Disposition', 'attachment; filename="erp_items.json"');
    res.json(items);
  })
);

// ---------------------------------------------------------------------------
// GET /erp/bom/:revisionId.csv | .json — single-level BOM for ERP
// ---------------------------------------------------------------------------

const BOM_CSV_HEADER = [
  'Parent Part Number',
  'Find Number',
  'Child Part Number',
  'Quantity',
  'UoM',
  'Ref Designators',
];

async function loadErpBom(
  revisionId: number,
  user: AclUser
): Promise<{
  fileToken: string;
  rows: ErpBomRowDto[];
}> {
  const revision = await prisma.partRevision.findFirst({
    where: { id: revisionId, part: aclFilter('PART', user) as Prisma.PartWhereInput },
    select: { id: true, revision: true, part: { select: { partNumber: true } } },
  });
  if (!revision) throw new HttpError(404, 'Revision not found');

  const lines = await prisma.bomLine.findMany({
    where: { parentRevisionId: revision.id },
    orderBy: { findNumber: 'asc' },
    include: { childPart: { select: { id: true, partNumber: true } } },
  });
  // Rule X4 — the row stays (find number, quantity: the ERP needs the structure to add up),
  // the hidden child's number does not.
  const visible = await visibleIds('PART', lines.map((line) => line.childPart.id), user);

  return {
    fileToken: `${safeFileToken(revision.part.partNumber)}_rev${safeFileToken(revision.revision)}`,
    rows: lines.map((line) => ({
      parentPartNumber: revision.part.partNumber,
      findNumber: line.findNumber,
      childPartNumber: visible.has(line.childPart.id)
        ? line.childPart.partNumber
        : REDACTED.partNumber,
      quantity: line.quantity,
      uom: line.uom,
      refDesignators: line.refDesignators ?? '',
    })),
  };
}

router.get(
  '/erp/bom/:revisionId.csv',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.revisionId, 'revisionId');
    const { fileToken, rows } = await loadErpBom(revisionId, aclUser(req));
    const csv = [csvRow(BOM_CSV_HEADER)];
    for (const row of rows) {
      csv.push(
        csvRow([
          row.parentPartNumber,
          String(row.findNumber),
          row.childPartNumber,
          String(row.quantity),
          row.uom,
          row.refDesignators,
        ])
      );
    }
    sendCsv(res, `${fileToken}_erp_bom.csv`, csv);
  })
);

router.get(
  '/erp/bom/:revisionId.json',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.revisionId, 'revisionId');
    const { fileToken, rows } = await loadErpBom(revisionId, aclUser(req));
    res.setHeader('Content-Disposition', `attachment; filename="${fileToken}_erp_bom.json"`);
    res.json(rows);
  })
);

// ---------------------------------------------------------------------------
// POST /erp/import/parts — item master import
// ---------------------------------------------------------------------------

interface PartRowSpec {
  row: number;
  partNumber: string;
  name: string;
  /** Only set when the cell carried a value — blank cells leave data untouched. */
  category?: PartCategory;
  uom?: string;
  unitCost?: number;
  description?: string;
}

function validatePartRow(table: CsvTable, row: CsvRow): RowOutcome<PartRowSpec> {
  const partNumber = cell(table, row, 'partNumber');
  if (partNumber === '') return { ok: false, message: 'partNumber is required' };
  if (partNumber.length > 40 || !PART_NUMBER_RE.test(partNumber)) {
    return {
      ok: false,
      message: `partNumber "${partNumber}" must be at most 40 characters of letters, digits, ".", "_" or "-"`,
    };
  }

  const name = cell(table, row, 'name');
  if (name === '') return { ok: false, message: 'name is required' };

  const spec: PartRowSpec = { row: row.row, partNumber, name };

  const categoryRaw = cell(table, row, 'category');
  if (categoryRaw !== '') {
    const category = matchCategory(categoryRaw);
    if (!category) return { ok: false, message: `Unknown category "${categoryRaw}"` };
    spec.category = category;
  }

  const uom = cell(table, row, 'uom');
  if (uom !== '') spec.uom = uom;

  const unitCostRaw = cell(table, row, 'unitCost');
  if (unitCostRaw !== '') {
    const unitCost = Number(unitCostRaw);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      return { ok: false, message: `unitCost "${unitCostRaw}" must be a non-negative number` };
    }
    spec.unitCost = unitCost;
  }

  const description = cell(table, row, 'description');
  if (description !== '') spec.description = description;

  return { ok: true, value: spec };
}

/**
 * One pass that validates, resolves every part against the database and — when
 * `apply` is set — writes. A dry run takes the identical path with `apply`
 * false, so its counts are exactly what a real import would produce.
 */
async function runPartsImport(
  db: Prisma.TransactionClient,
  table: CsvTable,
  userId: number,
  apply: boolean,
  user: AclUser
): Promise<ImportResultDto> {
  const issues: ImportIssueDto[] = [];
  const specs: PartRowSpec[] = [];
  for (const row of table.rows) {
    const outcome = validatePartRow(table, row);
    if (outcome.ok) specs.push(outcome.value);
    else issues.push({ row: row.row, message: outcome.message });
  }

  const existing = await db.part.findMany({
    where: { partNumber: { in: [...new Set(specs.map((spec) => spec.partNumber))] } },
    select: { id: true, partNumber: true },
  });
  // Matching is deliberately UNFILTERED: part numbers are unique, so a hidden part's number
  // would collide on create anyway — that oracle exists regardless. What the filter must stop
  // is the write: a matched part the caller may not WRITE is refused row by row (rule X2).
  const writableIds = new Set<number>();
  for (const part of existing) {
    try {
      await assertCanWrite('PART', part.id, user);
      writableIds.add(part.id);
    } catch {
      // Fail-closed: unreadable and read-only both land here.
    }
  }
  // Also tracks parts created earlier in this same import, so a part number
  // repeated in the CSV updates the first occurrence instead of colliding.
  const partIdByNumber = new Map<string, number | null>(
    existing.map((part) => [part.partNumber, part.id])
  );

  let created = 0;
  let updated = 0;
  for (const spec of specs) {
    const known = partIdByNumber.has(spec.partNumber);
    if (known) {
      const partId = partIdByNumber.get(spec.partNumber) ?? null;
      if (partId !== null && !writableIds.has(partId)) {
        issues.push({
          row: spec.row,
          message: `You do not have access to update ${spec.partNumber}`,
        });
        continue;
      }
      if (apply && partId !== null) {
        await db.part.update({
          where: { id: partId },
          data: {
            name: spec.name,
            ...(spec.category !== undefined ? { category: spec.category } : {}),
            ...(spec.uom !== undefined ? { uom: spec.uom } : {}),
            ...(spec.unitCost !== undefined ? { unitCost: spec.unitCost } : {}),
            ...(spec.description !== undefined ? { description: spec.description } : {}),
          },
        });
      }
      updated += 1;
      continue;
    }

    if (apply) {
      const part = await db.part.create({
        data: {
          partNumber: spec.partNumber,
          name: spec.name,
          ...(spec.category !== undefined ? { category: spec.category } : {}),
          ...(spec.uom !== undefined ? { uom: spec.uom } : {}),
          ...(spec.unitCost !== undefined ? { unitCost: spec.unitCost } : {}),
          ...(spec.description !== undefined ? { description: spec.description } : {}),
          createdById: userId,
          revisions: {
            create: { revision: 'A', lifecycle: Lifecycle.IN_WORK, createdById: userId },
          },
        },
        select: { id: true },
      });
      partIdByNumber.set(spec.partNumber, part.id);
    } else {
      partIdByNumber.set(spec.partNumber, null);
    }
    created += 1;
  }

  return {
    dryRun: !apply,
    parsed: table.rows.length,
    created,
    updated,
    skipped: issues.length,
    issues,
  };
}

router.post(
  '/erp/import/parts',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const { csv, dryRun } = parseImportBody(req);
    const table = readCsvTable(csv, ['partNumber', 'name']);

    const result = dryRun
      ? await runPartsImport(prisma, table, userId, false, aclUser(req))
      : await prisma.$transaction(
          (tx) => runPartsImport(tx, table, userId, true, aclUser(req)),
          IMPORT_TX_OPTIONS
        );
    res.json(result);
  })
);

// ---------------------------------------------------------------------------
// POST /erp/import/bom/:revisionId — single-level BOM import
// ---------------------------------------------------------------------------

interface BomRowSpec {
  row: number;
  childPartNumber: string;
  /** Only set when the cell carried a value — blank cells leave data untouched. */
  quantity?: number;
  uom?: string;
  findNumber?: number;
  refDesignators?: string;
}

function validateBomRow(table: CsvTable, row: CsvRow): RowOutcome<BomRowSpec> {
  const childPartNumber = cell(table, row, 'childPartNumber');
  if (childPartNumber === '') return { ok: false, message: 'childPartNumber is required' };

  const spec: BomRowSpec = { row: row.row, childPartNumber };

  const quantityRaw = cell(table, row, 'quantity');
  if (quantityRaw !== '') {
    const quantity = Number(quantityRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, message: `quantity "${quantityRaw}" must be a number greater than 0` };
    }
    spec.quantity = quantity;
  }

  const uom = cell(table, row, 'uom');
  if (uom !== '') spec.uom = uom;

  const findNumberRaw = cell(table, row, 'findNumber');
  if (findNumberRaw !== '') {
    const findNumber = Number(findNumberRaw);
    if (!Number.isInteger(findNumber) || findNumber <= 0 || findNumber > 2147483647) {
      return { ok: false, message: `findNumber "${findNumberRaw}" must be a positive integer` };
    }
    spec.findNumber = findNumber;
  }

  const refDesignators = cell(table, row, 'refDesignators');
  if (refDesignators !== '') spec.refDesignators = refDesignators;

  return { ok: true, value: spec };
}

/**
 * Rule 4 — cycle prevention, reachability form (same conservative BFS as
 * bom.ts). The adjacency snapshot is taken once per import: every line the
 * import adds is an out-edge of the parent revision's own part, and out-edges
 * of the parent can never change whether the parent is *reachable*, so the
 * snapshot stays correct for every row.
 */
function buildAdjacency(
  edges: { childPartId: number; parentRevision: { partId: number } }[]
): Map<number, number[]> {
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const from = edge.parentRevision.partId;
    const targets = adjacency.get(from);
    if (targets) targets.push(edge.childPartId);
    else adjacency.set(from, [edge.childPartId]);
  }
  return adjacency;
}

function createsCycle(
  adjacency: Map<number, number[]>,
  parentPartId: number,
  childPartId: number
): boolean {
  if (childPartId === parentPartId) return true;
  const visited = new Set<number>([childPartId]);
  const queue: number[] = [childPartId];
  for (const current of queue) {
    if (current === parentPartId) return true;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

async function runBomImport(
  db: Prisma.TransactionClient,
  table: CsvTable,
  revision: { id: number; partId: number },
  apply: boolean
): Promise<ImportResultDto> {
  const issues: ImportIssueDto[] = [];
  const specs: BomRowSpec[] = [];
  for (const row of table.rows) {
    const outcome = validateBomRow(table, row);
    if (outcome.ok) specs.push(outcome.value);
    else issues.push({ row: row.row, message: outcome.message });
  }

  const [parts, existingLines, edges] = await Promise.all([
    db.part.findMany({
      where: { partNumber: { in: [...new Set(specs.map((spec) => spec.childPartNumber))] } },
      select: { id: true, partNumber: true },
    }),
    db.bomLine.findMany({
      where: { parentRevisionId: revision.id },
      select: { id: true, childPartId: true, findNumber: true },
    }),
    db.bomLine.findMany({
      select: { childPartId: true, parentRevision: { select: { partId: true } } },
    }),
  ]);

  const partIdByNumber = new Map(parts.map((part) => [part.partNumber, part.id]));
  const adjacency = buildAdjacency(edges);
  // Includes lines planned by this import, so a child repeated in the CSV
  // updates the line the earlier row produced instead of colliding.
  const lineIdByChild = new Map<number, number | null>(
    existingLines.map((line) => [line.childPartId, line.id])
  );
  const usedFindNumbers = new Set<number>(existingLines.map((line) => line.findNumber));
  let maxFindNumber = existingLines.reduce((max, line) => Math.max(max, line.findNumber), 0);

  let created = 0;
  let updated = 0;
  for (const spec of specs) {
    const childPartId = partIdByNumber.get(spec.childPartNumber);
    if (childPartId === undefined) {
      issues.push({ row: spec.row, message: `Unknown part number "${spec.childPartNumber}"` });
      continue;
    }

    if (lineIdByChild.has(childPartId)) {
      // Existing line — quantity/uom/refDes only; the find number is left alone.
      const lineId = lineIdByChild.get(childPartId) ?? null;
      if (apply && lineId !== null) {
        await db.bomLine.update({
          where: { id: lineId },
          data: {
            ...(spec.quantity !== undefined ? { quantity: spec.quantity } : {}),
            ...(spec.uom !== undefined ? { uom: spec.uom } : {}),
            ...(spec.refDesignators !== undefined
              ? { refDesignators: spec.refDesignators }
              : {}),
          },
        });
      }
      updated += 1;
      continue;
    }

    if (createsCycle(adjacency, revision.partId, childPartId)) {
      issues.push({ row: spec.row, message: 'Adding this part would create a BOM cycle' });
      continue;
    }

    // A blank quantity means "leave as-is" when updating, but a new line has
    // nothing to leave — never silently invent a quantity of 1.
    if (spec.quantity === undefined) {
      issues.push({ row: spec.row, message: 'quantity is required for a new BOM line' });
      continue;
    }

    let findNumber: number;
    if (spec.findNumber !== undefined) {
      if (usedFindNumbers.has(spec.findNumber)) {
        issues.push({ row: spec.row, message: `Find number ${spec.findNumber} is already used` });
        continue;
      }
      findNumber = spec.findNumber;
    } else {
      // Rule 8 — next multiple of 10 (start 10).
      findNumber = Math.floor(maxFindNumber / 10) * 10 + 10;
    }

    let lineId: number | null = null;
    if (apply) {
      const line = await db.bomLine.create({
        data: {
          parentRevisionId: revision.id,
          childPartId,
          findNumber,
          ...(spec.quantity !== undefined ? { quantity: spec.quantity } : {}),
          ...(spec.uom !== undefined ? { uom: spec.uom } : {}),
          refDesignators: spec.refDesignators ?? null,
        },
        select: { id: true },
      });
      lineId = line.id;
    }
    lineIdByChild.set(childPartId, lineId);
    usedFindNumbers.add(findNumber);
    if (findNumber > maxFindNumber) maxFindNumber = findNumber;
    created += 1;
  }

  return {
    dryRun: !apply,
    parsed: table.rows.length,
    created,
    updated,
    skipped: issues.length,
    // Lookup issues are found after the parse issues — report them in file order.
    issues: issues.sort((a, b) => a.row - b.row),
  };
}

router.post(
  '/erp/import/bom/:revisionId',
  asyncHandler(async (req, res) => {
    const revisionId = idParam(req.params.revisionId, 'revisionId');
    const user = aclUser(req);
    const revision = await prisma.partRevision.findFirst({
      where: { id: revisionId, part: aclFilter('PART', user) as Prisma.PartWhereInput },
      select: { id: true, partId: true, revision: true, lifecycle: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    await assertCanWrite('PART', revision.partId, user);
    // Rule 1 — edit gate.
    if (revision.lifecycle !== Lifecycle.IN_WORK) {
      throw new HttpError(
        409,
        `Revision ${revision.revision} is ${revision.lifecycle} and cannot be modified`
      );
    }

    const { csv, dryRun } = parseImportBody(req);
    const table = readCsvTable(csv, ['childPartNumber', 'quantity']);
    const target = { id: revision.id, partId: revision.partId };

    const result = dryRun
      ? await runBomImport(prisma, table, target, false)
      : await prisma.$transaction((tx) => runBomImport(tx, table, target, true), IMPORT_TX_OPTIONS);
    res.json(result);
  })
);

export default router;
