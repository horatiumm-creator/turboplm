import fs from 'fs';
import path from 'path';
import { Request, Router } from 'express';
import {
  CatalogFormat,
  CatalogImportStatus,
  CatalogRowStatus,
  Lifecycle,
  PartCategory,
  Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, assertCanWrite } from '../lib/acl';
import { absoluteStoragePath, removeStoredFile, uploadSingle } from '../middleware/upload';
import { generatePartNumber, withNumberLock } from '../lib/plm';
import {
  applyMapping,
  BUILT_IN_MAPPINGS,
  CATALOG_TARGET_FIELDS,
  classifyRow,
  detectVendor,
  matchesHeaderSignature,
  parseCatalogFile,
  REQUIRED_TARGET_FIELDS,
} from '../lib/catalogParse';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Local DTO shapes (must match frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

type CatalogTargetField =
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

interface UserRefDto {
  id: number;
  name: string;
}

interface CatalogMappingDto {
  id: number;
  name: string;
  vendor: string | null;
  format: CatalogFormat;
  /** target field -> source column name. Partial: unmapped targets are absent. */
  fieldMap: Partial<Record<CatalogTargetField, string>>;
  /** Literal values for fields the file does not carry, e.g. { category: 'PURCHASED' }. */
  defaults: Partial<Record<CatalogTargetField, string>> | null;
  headerSignature: string[];
  builtIn: boolean;
  createdBy: UserRefDto | null;
  createdAt: string;
}

interface CatalogImportCountsDto {
  rows: number;
  new: number;
  update: number;
  duplicate: number;
  invalid: number;
  skipped: number;
  committed: number;
  failed: number;
}

interface CatalogImportSummaryDto {
  id: number;
  fileName: string;
  format: CatalogFormat;
  status: CatalogImportStatus;
  detectedVendor: string | null;
  mapping: { id: number; name: string } | null;
  counts: CatalogImportCountsDto;
  error: string | null;
  createdBy: UserRefDto;
  createdAt: string;
  validatedAt: string | null;
  committedAt: string | null;
}

interface CatalogImportDetailDto extends CatalogImportSummaryDto {
  /** Source column names in file order — what the mapping UI offers. */
  sourceColumns: string[];
  /** Built-in preset whose headerSignature matched, if any. */
  suggestedMappingId: number | null;
  /** First 5 source rows verbatim, so the user can see what they are mapping. */
  sampleRows: Record<string, string>[];
}

interface CatalogMappedRowDto {
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

interface CatalogImportRowDto {
  id: number;
  lineNumber: number;
  status: CatalogRowStatus;
  message: string | null;
  raw: Record<string, string>;
  /** null until the import has been validated. */
  mapped: CatalogMappedRowDto | null;
  /** Set on commit. */
  part: { id: number; partNumber: string; name: string } | null;
  manufacturerPart: { id: number; mpn: string; manufacturer: string } | null;
}

interface PagedDto<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The mappable targets and the two required ones both come from the parser (rule V3). */
const TARGET_FIELDS: CatalogTargetField[] = CATALOG_TARGET_FIELDS;
const REQUIRED_TARGETS: CatalogTargetField[] = REQUIRED_TARGET_FIELDS;

/**
 * Rule V2 caps a catalog at 25 MB — below the shared 50 MB multer limit, so the cap has to
 * be enforced here rather than by the middleware.
 */
const MAX_CATALOG_BYTES = 25 * 1024 * 1024;

const STAGE_CHUNK = 500;
const VALIDATE_CHUNK = 250;
/**
 * Rows per commit transaction. Deliberately small: a chunk runs inside `withNumberLock`,
 * whose transaction uses Prisma's default 5 s timeout, and holding the numbering lock
 * blocks every other number allocation in the system while it is held.
 */
const COMMIT_CHUNK = 100;
const MPN_LOOKUP_CHUNK = 1000;

const IMPORT_TX_OPTIONS = { maxWait: 15_000, timeout: 120_000 } as const;

// ---------------------------------------------------------------------------
// Body / query validation helpers
// ---------------------------------------------------------------------------

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  // A body-less POST (validate/commit take no required fields) must not be rejected.
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'name is required');
  }
  const trimmed = value.trim();
  if (trimmed.length > 120) throw new HttpError(400, 'name must be at most 120 characters');
  return trimmed;
}

function optionalNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${label} must be a boolean`);
  return value;
}

function requirePositiveInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return n;
}

function requireFormat(value: unknown): CatalogFormat {
  if (typeof value !== 'string' || !(Object.values(CatalogFormat) as string[]).includes(value)) {
    throw new HttpError(400, 'format must be one of CSV, XLSX, BMECAT_XML');
  }
  return value as CatalogFormat;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array of strings`);
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new HttpError(400, `${label} must be an array of strings`);
    return entry.trim();
  });
}

type FieldMap = Partial<Record<CatalogTargetField, string>>;

/**
 * A target whose value is empty means "not mapped": the mapping UI posts every select,
 * including the ones the user left blank, and an empty select must not become a mapping
 * onto a column named "".
 */
function requireFieldMap(value: unknown, label: string): FieldMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object of target field to source column`);
  }
  const out: FieldMap = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!TARGET_FIELDS.includes(key as CatalogTargetField)) {
      throw new HttpError(400, `${label} has an unknown target field "${key}"`);
    }
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string') throw new HttpError(400, `${label}.${key} must be a string`);
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    out[key as CatalogTargetField] = trimmed;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON column readers — Prisma hands these back as JsonValue
// ---------------------------------------------------------------------------

function fieldMapFromJson(value: Prisma.JsonValue | null): FieldMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: FieldMap = {};
  for (const target of TARGET_FIELDS) {
    const raw = (value as Record<string, unknown>)[target];
    if (typeof raw === 'string' && raw.trim() !== '') out[target] = raw.trim();
  }
  return out;
}

function rawFromJson(value: Prisma.JsonValue): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, cell] of Object.entries(value as Record<string, unknown>)) {
    out[key] = cell === null || cell === undefined ? '' : String(cell);
  }
  return out;
}

function mappedFromJson(value: Prisma.JsonValue | null): CatalogMappedRowDto | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const text = (key: string): string | null => {
    const cell = source[key];
    return typeof cell === 'string' && cell.trim() !== '' ? cell : null;
  };
  const unitCost = source.unitCost;
  return {
    partNumber: text('partNumber'),
    name: text('name'),
    description: text('description'),
    category: text('category'),
    uom: text('uom'),
    unitCost: typeof unitCost === 'number' && Number.isFinite(unitCost) ? unitCost : null,
    manufacturerName: text('manufacturerName'),
    mpn: text('mpn'),
    distributorName: text('distributorName'),
    distributorPartNumber: text('distributorPartNumber'),
  };
}

function asJson(value: unknown): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

const mappingInclude = {
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.CatalogMappingInclude;

type MappingRow = Prisma.CatalogMappingGetPayload<{ include: typeof mappingInclude }>;

function toMapping(row: MappingRow): CatalogMappingDto {
  const defaults = fieldMapFromJson(row.defaults);
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    format: row.format,
    fieldMap: fieldMapFromJson(row.fieldMap),
    defaults: Object.keys(defaults).length > 0 ? defaults : null,
    headerSignature: row.headerSignature,
    builtIn: row.builtIn,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const importInclude = {
  mapping: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.CatalogImportInclude;

type ImportRow = Prisma.CatalogImportGetPayload<{ include: typeof importInclude }>;

function toImportSummary(row: ImportRow): CatalogImportSummaryDto {
  return {
    id: row.id,
    fileName: row.fileName,
    format: row.format,
    status: row.status,
    detectedVendor: row.detectedVendor,
    mapping: row.mapping ? { id: row.mapping.id, name: row.mapping.name } : null,
    counts: {
      rows: row.rowCount,
      new: row.newCount,
      update: row.updateCount,
      duplicate: row.duplicateCount,
      invalid: row.invalidCount,
      skipped: row.skippedCount,
      committed: row.committedCount,
      failed: row.failedCount,
    },
    error: row.error,
    createdBy: { id: row.createdBy.id, name: row.createdBy.name },
    createdAt: row.createdAt.toISOString(),
    validatedAt: row.validatedAt ? row.validatedAt.toISOString() : null,
    committedAt: row.committedAt ? row.committedAt.toISOString() : null,
  };
}

/**
 * The preset suggestion is recomputed per request rather than stored: presets are seeded
 * and editable independently of the upload, so a stored id would go stale.
 */
async function suggestMappingId(
  sourceColumns: string[],
  detectedVendor: string | null
): Promise<number | null> {
  const builtIns = await prisma.catalogMapping.findMany({
    where: { builtIn: true },
    orderBy: { id: 'asc' },
    select: { id: true, vendor: true, headerSignature: true },
  });
  // Use the SAME matcher vendor detection uses. This compared exact lowercased strings while
  // detectVendor normalizes punctuation away, so Digi-Key's de-hyphenated export spelling
  // ("DigiKey Part Number") reported a detected vendor and then offered no preset for it —
  // the one case the suggestion exists for. catalogParse exports matchesHeaderSignature
  // precisely so the two cannot drift apart again.
  const matches = builtIns.filter(
    (mapping) =>
      mapping.headerSignature.length > 0 &&
      matchesHeaderSignature(sourceColumns, mapping.headerSignature)
  );
  if (matches.length === 0) return null;
  const vendorMatch = detectedVendor
    ? matches.find((mapping) => mapping.vendor?.toLowerCase() === detectedVendor.toLowerCase())
    : undefined;
  return (vendorMatch ?? matches[0]).id;
}

async function toImportDetail(row: ImportRow): Promise<CatalogImportDetailDto> {
  const [samples, suggestedMappingId] = await Promise.all([
    prisma.catalogImportRow.findMany({
      where: { importId: row.id },
      orderBy: { lineNumber: 'asc' },
      take: 5,
      select: { raw: true },
    }),
    suggestMappingId(row.sourceColumns, row.detectedVendor),
  ]);
  return {
    ...toImportSummary(row),
    sourceColumns: row.sourceColumns,
    suggestedMappingId,
    sampleRows: samples.map((sample) => rawFromJson(sample.raw)),
  };
}

async function getImportOrThrow(id: number): Promise<ImportRow> {
  const row = await prisma.catalogImport.findUnique({ where: { id }, include: importInclude });
  if (!row) throw new HttpError(404, 'Catalog import not found');
  return row;
}

async function getImportDetailOrThrow(id: number): Promise<CatalogImportDetailDto> {
  return toImportDetail(await getImportOrThrow(id));
}

const importRowInclude = {
  part: { select: { id: true, partNumber: true, name: true } },
  manufacturerPart: {
    select: { id: true, mpn: true, manufacturer: { select: { name: true } } },
  },
} satisfies Prisma.CatalogImportRowInclude;

type ImportRowRow = Prisma.CatalogImportRowGetPayload<{ include: typeof importRowInclude }>;

function toImportRow(row: ImportRowRow): CatalogImportRowDto {
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    status: row.status,
    message: row.message,
    raw: rawFromJson(row.raw),
    mapped: mappedFromJson(row.mapped),
    part: row.part
      ? { id: row.part.id, partNumber: row.part.partNumber, name: row.part.name }
      : null,
    manufacturerPart: row.manufacturerPart
      ? {
          id: row.manufacturerPart.id,
          mpn: row.manufacturerPart.mpn,
          manufacturer: row.manufacturerPart.manufacturer.name,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Count bookkeeping — the import's counters are always derived from its rows, so a
// re-validation or a per-row skip can never leave the summary lying about the preview.
// ---------------------------------------------------------------------------

type StatusCounts = Record<CatalogRowStatus, number>;

async function countRowsByStatus(importId: number): Promise<StatusCounts> {
  const groups = await prisma.catalogImportRow.groupBy({
    by: ['status'],
    where: { importId },
    _count: { _all: true },
  });
  const counts = {
    NEW: 0,
    UPDATE: 0,
    DUPLICATE: 0,
    INVALID: 0,
    SKIPPED: 0,
    COMMITTED: 0,
  } as StatusCounts;
  for (const group of groups) counts[group.status] = group._count._all;
  return counts;
}

function countData(counts: StatusCounts) {
  return {
    newCount: counts.NEW,
    updateCount: counts.UPDATE,
    duplicateCount: counts.DUPLICATE,
    invalidCount: counts.INVALID,
    skippedCount: counts.SKIPPED,
    committedCount: counts.COMMITTED,
  };
}

// ---------------------------------------------------------------------------
// Manufacturer / MPN lookups
// ---------------------------------------------------------------------------

/** NUL: a manufacturer name containing the separator must not forge another pair's key. */
const KEY_SEPARATOR = '\u0000';

function nameKey(value: string): string {
  return value.trim().toLowerCase();
}

/** Rule V3 compares manufacturer names case-insensitively. */
function dupKey(mapped: CatalogMappedRowDto): string {
  return `${nameKey(mapped.manufacturerName ?? '')}${KEY_SEPARATOR}${nameKey(mapped.mpn ?? '')}`;
}

/**
 * Case-insensitive name -> id index for the whole Manufacturer table. One query beats a
 * per-row `mode: 'insensitive'` lookup for a 5,000-row file, and the table is small (a
 * PLM has vendors, not transactions, in it).
 */
async function loadManufacturerIndex(): Promise<Map<string, number>> {
  const manufacturers = await prisma.manufacturer.findMany({ select: { id: true, name: true } });
  const index = new Map<string, number>();
  for (const manufacturer of manufacturers) index.set(nameKey(manufacturer.name), manufacturer.id);
  return index;
}

/**
 * Which (manufacturerId, lower(mpn)) pairs already have a ManufacturerPart. Raw SQL because
 * Prisma cannot express a case-insensitive `IN` list, and the alternative — loading every
 * manufacturer part of every vendor in the file — is unbounded.
 */
async function findExistingMpnKeys(
  manufacturerIds: number[],
  mpns: string[]
): Promise<Set<string>> {
  const found = new Set<string>();
  if (manufacturerIds.length === 0 || mpns.length === 0) return found;
  for (let start = 0; start < mpns.length; start += MPN_LOOKUP_CHUNK) {
    const slice = mpns.slice(start, start + MPN_LOOKUP_CHUNK);
    const rows = await prisma.$queryRaw<{ manufacturerId: number; mpn: string }[]>(Prisma.sql`
      SELECT DISTINCT "manufacturerId", lower("mpn") AS mpn
      FROM "ManufacturerPart"
      WHERE "manufacturerId" IN (${Prisma.join(manufacturerIds)})
        AND lower("mpn") IN (${Prisma.join(slice)})`);
    for (const row of rows) found.add(`${row.manufacturerId}${KEY_SEPARATOR}${row.mpn}`);
  }
  return found;
}

function errorMessage(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unexpected error';
}

// ---------------------------------------------------------------------------
// POST /catalog-imports — upload and stage (rule V2)
// ---------------------------------------------------------------------------

router.post(
  '/catalog-imports',
  uploadSingle,
  asyncHandler(async (req, res) => {
    const file = req.file;
    try {
      if (!file) throw new HttpError(400, 'file is required');
      const userId = currentUserId(req);

      const fileName = path.basename(file.originalname);
      if (file.size > MAX_CATALOG_BYTES) {
        throw new HttpError(413, 'File exceeds the 25 MB catalog upload limit');
      }

      const buffer = await fs.promises.readFile(absoluteStoragePath(file.filename));
      const parsed = parseCatalogFile(buffer, fileName);
      if (parsed.rows.length === 0) throw new HttpError(400, 'The file has no data rows');

      const detected = detectVendor(parsed.columns);

      // Staging writes nothing outside the import tables (rule V2): the upload becomes
      // rows, not parts.
      const created = await prisma.$transaction(async (tx) => {
        const record = await tx.catalogImport.create({
          data: {
            fileName,
            format: parsed.format,
            status: CatalogImportStatus.DRAFT,
            detectedVendor: detected?.vendor ?? null,
            sourceColumns: parsed.columns,
            rowCount: parsed.rows.length,
            createdById: userId,
          },
          select: { id: true },
        });
        for (let start = 0; start < parsed.rows.length; start += STAGE_CHUNK) {
          await tx.catalogImportRow.createMany({
            data: parsed.rows.slice(start, start + STAGE_CHUNK).map((raw, offset) => ({
              importId: record.id,
              lineNumber: start + offset + 1,
              raw: asJson(raw),
            })),
          });
        }
        return record;
      }, IMPORT_TX_OPTIONS);

      res.status(201).json(await getImportDetailOrThrow(created.id));
    } finally {
      // Every source row is stored verbatim in `raw`, so nothing ever reads the uploaded
      // file again — keeping it would only leak vendor price lists onto the disk.
      if (file) removeStoredFile(file.filename);
    }
  })
);

// ---------------------------------------------------------------------------
// GET /catalog-imports — paged list, newest first
// ---------------------------------------------------------------------------

router.get(
  '/catalog-imports',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const [total, imports] = await Promise.all([
      prisma.catalogImport.count(),
      prisma.catalogImport.findMany({
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: importInclude,
      }),
    ]);

    const payload: PagedDto<CatalogImportSummaryDto> = {
      items: imports.map(toImportSummary),
      total,
      page,
      pageSize,
    };
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// GET /catalog-imports/:id
// ---------------------------------------------------------------------------

router.get(
  '/catalog-imports/:id',
  asyncHandler(async (req, res) => {
    res.json(await getImportDetailOrThrow(idParam(req.params.id)));
  })
);

// ---------------------------------------------------------------------------
// DELETE /catalog-imports/:id — never a committed import (rule V2)
// ---------------------------------------------------------------------------

router.delete(
  '/catalog-imports/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const record = await prisma.catalogImport.findUnique({
      where: { id },
      select: { id: true, fileName: true, status: true },
    });
    if (!record) throw new HttpError(404, 'Catalog import not found');
    if (record.status === CatalogImportStatus.COMMITTED) {
      throw new HttpError(409, `${record.fileName} is committed and cannot be deleted`);
    }
    await prisma.catalogImport.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /catalog-imports/:id/validate — map, classify, preview (rule V3)
// ---------------------------------------------------------------------------

interface RowPlan {
  id: number;
  lineNumber: number;
  mapped: CatalogMappedRowDto;
  status: CatalogRowStatus;
  message: string | null;
}

router.post(
  '/catalog-imports/:id/validate',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = bodyOf(req);
    const record = await getImportOrThrow(id);
    if (record.status === CatalogImportStatus.COMMITTED) {
      throw new HttpError(409, `${record.fileName} is committed and cannot be validated again`);
    }

    // Mapping resolution: an explicit fieldMap always wins (the UI edits a preset before
    // validating), a mappingId supplies both halves, and a bare re-run reuses whatever the
    // previous run used.
    let mappingId: number | null = null;
    let fieldMap: FieldMap | null = null;
    let defaults: FieldMap | null = null;

    if (body.mappingId !== undefined && body.mappingId !== null) {
      const requested = requirePositiveInt(body.mappingId, 'mappingId');
      const mapping = await prisma.catalogMapping.findUnique({ where: { id: requested } });
      if (!mapping) throw new HttpError(404, 'Catalog mapping not found');
      mappingId = mapping.id;
      fieldMap = fieldMapFromJson(mapping.fieldMap);
      defaults = fieldMapFromJson(mapping.defaults);
    } else if (record.mappingId !== null && body.fieldMap === undefined) {
      const mapping = await prisma.catalogMapping.findUnique({ where: { id: record.mappingId } });
      if (mapping) {
        mappingId = mapping.id;
        fieldMap = fieldMapFromJson(mapping.fieldMap);
        defaults = fieldMapFromJson(mapping.defaults);
      }
    }
    if (body.fieldMap !== undefined) fieldMap = requireFieldMap(body.fieldMap, 'fieldMap');
    if (body.defaults !== undefined) {
      defaults = body.defaults === null ? null : requireFieldMap(body.defaults, 'defaults');
    }
    if (!fieldMap) {
      throw new HttpError(400, 'Provide a mappingId or a fieldMap to validate the import');
    }

    const effective = fieldMap;
    const literals = defaults;
    const missing = REQUIRED_TARGETS.filter(
      (target) => !effective[target] && !(literals && literals[target])
    );
    if (missing.length > 0) {
      throw new HttpError(
        400,
        `Map the required target field${missing.length > 1 ? 's' : ''} ${missing.join(' and ')}`
      );
    }

    // An MPN has nothing to hang on without a manufacturer: the AML entry is keyed on the
    // pair. Previously such a mapping validated happily, the commit wrote Parts only, and the
    // MPN the user had carefully mapped was discarded without a word — while the commit
    // summary still promised a manufacturer part per row. A single-vendor catalog with no
    // manufacturer column satisfies this with a default.
    const hasManufacturer =
      Boolean(effective.manufacturerName) || Boolean(literals && literals.manufacturerName);
    if (!hasManufacturer) {
      throw new HttpError(
        400,
        'Map or default manufacturerName — an MPN cannot be recorded without the manufacturer it belongs to'
      );
    }

    const rows = await prisma.catalogImportRow.findMany({
      where: { importId: id },
      orderBy: { lineNumber: 'asc' },
      select: { id: true, lineNumber: true, raw: true, status: true, mapped: true },
    });

    // Pass 1 — map, apply INVALID and in-file DUPLICATE. No database writes yet, so a
    // mapping that turns out to be wrong costs nothing.
    const plans: RowPlan[] = [];
    const firstSeenLine = new Map<string, number>();
    const candidates: RowPlan[] = [];

    for (const row of rows) {
      // A row committed by an earlier run is an audit record of what was written; its
      // mapped snapshot must survive re-validation untouched.
      if (row.status === CatalogRowStatus.COMMITTED) {
        const committedMapped = mappedFromJson(row.mapped);
        if (committedMapped) {
          const key = dupKey(committedMapped);
          if (!firstSeenLine.has(key)) firstSeenLine.set(key, row.lineNumber);
        }
        continue;
      }

      let mapped: CatalogMappedRowDto;
      let status: CatalogRowStatus;
      let message: string | null = null;
      try {
        mapped = applyMapping(rawFromJson(row.raw), effective, literals);
        const verdict = classifyRow(mapped);
        if (!verdict.ok) {
          status = CatalogRowStatus.INVALID;
          message = verdict.message;
        } else {
          const key = dupKey(mapped);
          const firstLine = firstSeenLine.get(key);
          if (firstLine !== undefined) {
            status = CatalogRowStatus.DUPLICATE;
            message = `Duplicate of line ${firstLine} in this file`;
          } else {
            firstSeenLine.set(key, row.lineNumber);
            status = CatalogRowStatus.NEW;
          }
        }
      } catch (err) {
        mapped = {
          partNumber: null,
          name: null,
          description: null,
          category: null,
          uom: null,
          unitCost: null,
          manufacturerName: null,
          mpn: null,
          distributorName: null,
          distributorPartNumber: null,
        };
        status = CatalogRowStatus.INVALID;
        message = errorMessage(err);
      }

      const plan: RowPlan = { id: row.id, lineNumber: row.lineNumber, mapped, status, message };
      if (row.status === CatalogRowStatus.SKIPPED) {
        // Losing a skip the user set in the preview would be infuriating, so the user's
        // choice outranks the fresh classification — but its reason is worth keeping when
        // the new mapping also makes the row invalid.
        plan.status = CatalogRowStatus.SKIPPED;
        if (status !== CatalogRowStatus.INVALID) plan.message = null;
      } else if (status === CatalogRowStatus.NEW) {
        // Only a row that would be written needs the AML lookup in pass 2.
        candidates.push(plan);
      }
      plans.push(plan);
    }

    // Pass 2 — UPDATE for rows whose (manufacturer, mpn) already exists in the AML.
    if (candidates.length > 0) {
      const index = await loadManufacturerIndex();
      const manufacturerIds = new Set<number>();
      const mpnKeys = new Set<string>();
      for (const plan of candidates) {
        const manufacturerId = index.get(nameKey(plan.mapped.manufacturerName ?? ''));
        if (manufacturerId === undefined) continue;
        manufacturerIds.add(manufacturerId);
        mpnKeys.add(nameKey(plan.mapped.mpn ?? ''));
      }
      const existing = await findExistingMpnKeys([...manufacturerIds], [...mpnKeys]);
      for (const plan of candidates) {
        const manufacturerId = index.get(nameKey(plan.mapped.manufacturerName ?? ''));
        if (manufacturerId === undefined) continue;
        const key = `${manufacturerId}${KEY_SEPARATOR}${nameKey(plan.mapped.mpn ?? '')}`;
        if (existing.has(key)) plan.status = CatalogRowStatus.UPDATE;
      }
    }

    for (let start = 0; start < plans.length; start += VALIDATE_CHUNK) {
      const chunk = plans.slice(start, start + VALIDATE_CHUNK);
      await prisma.$transaction(
        chunk.map((plan) =>
          prisma.catalogImportRow.update({
            where: { id: plan.id },
            data: {
              mapped: asJson(plan.mapped),
              status: plan.status,
              message: plan.message,
              // Nothing is written to Part/ManufacturerPart during validation, so any link
              // left over from a failed commit is stale.
              partId: null,
              manufacturerPartId: null,
            },
          })
        )
      );
    }

    const counts = await countRowsByStatus(id);
    await prisma.catalogImport.update({
      where: { id },
      data: {
        ...countData(counts),
        mappingId,
        status: CatalogImportStatus.VALIDATED,
        // Recorded so the mapping can be recovered and saved later (rule V5).
        appliedFieldMap: fieldMap as Prisma.InputJsonValue,
        appliedDefaults: (defaults ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        validatedAt: new Date(),
        failedCount: 0,
        error: null,
      },
    });

    res.json(await getImportDetailOrThrow(id));
  })
);

// ---------------------------------------------------------------------------
// POST /catalog-imports/:id/commit — write parts and AML entries (rule V4)
// ---------------------------------------------------------------------------

interface CommitTask {
  id: number;
  lineNumber: number;
  mapped: CatalogMappedRowDto;
  /** null when the file carries no manufacturer: the row then becomes a Part only. */
  manufacturerId: number | null;
}

function requireCategory(value: string): PartCategory {
  const upper = value.trim().toUpperCase();
  if (!(Object.values(PartCategory) as string[]).includes(upper)) {
    throw new Error(`category "${value}" is not a valid category`);
  }
  return upper as PartCategory;
}

/**
 * Write one row. Runs inside the caller's transaction so a failure rolls the row's part,
 * revision and AML entry back together — a half-created part is worse than a failed row.
 */
function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

/**
 * Rule X2 for imports — a row that would AMEND an existing part must hold WRITE on it. The
 * check throws a row-level error (the row fails, the batch continues), matching how every
 * other malformed row is reported. Creates need no check: a new part has no grants.
 */
async function assertRowCanAmend(partId: number, user: AclUser): Promise<void> {
  try {
    await assertCanWrite('PART', partId, user);
  } catch {
    // Unreadable and read-only both land here; the message deliberately does not
    // distinguish them.
    throw new Error('You do not have access to update the matched part');
  }
}

async function commitRow(
  tx: Prisma.TransactionClient,
  task: CommitTask,
  userId: number,
  user: AclUser
): Promise<void> {
  const mapped = task.mapped;
  const name = (mapped.name ?? '').trim();
  const mpn = (mapped.mpn ?? '').trim();
  if (name === '' || mpn === '') throw new Error('name and mpn are required');

  const category = mapped.category ? requireCategory(mapped.category) : undefined;
  const uom = (mapped.uom ?? '').trim() || undefined;
  const description = (mapped.description ?? '').trim() || undefined;
  const unitCost = mapped.unitCost ?? undefined;
  const distributorName = (mapped.distributorName ?? '').trim() || undefined;
  const distributorPartNumber = (mapped.distributorPartNumber ?? '').trim() || undefined;

  const partData = {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(uom !== undefined ? { uom } : {}),
    ...(unitCost !== undefined ? { unitCost } : {}),
  };

  // The AML entry decides whether this row amends an existing part or creates one; it is
  // re-read here because validation deliberately wrote nothing and time has passed.
  const existingAml =
    task.manufacturerId === null
      ? null
      : // Case-insensitive comparison via raw lower(), NOT Prisma's `mode:'insensitive'`.
        // On Postgres that mode lowers to an unescaped ILIKE, so `_` and `%` inside an MPN
        // become wildcards — and MPNs contain underscores routinely. A row the preview
        // classified NEW could then match, and silently amend, a completely different part.
        // Validation already compares with exact lower(...) IN (...), so this also keeps
        // commit and validate agreeing about what "already exists" means.
        (
          await tx.$queryRaw<{ id: number; partId: number }[]>`
            SELECT id, "partId" FROM "ManufacturerPart"
            WHERE "manufacturerId" = ${task.manufacturerId}
              AND lower("mpn") = lower(${mpn})
            LIMIT 1`
        )[0] ?? null;

  let partId: number;
  if (existingAml) {
    partId = existingAml.partId;
    await assertRowCanAmend(partId, user);
    await tx.part.update({ where: { id: partId }, data: partData });
  } else {
    const wanted = (mapped.partNumber ?? '').trim();
    const existingPart =
      wanted === ''
        ? null
        : await tx.part.findUnique({ where: { partNumber: wanted }, select: { id: true } });
    if (existingPart) {
      partId = existingPart.id;
      await assertRowCanAmend(partId, user);
      await tx.part.update({ where: { id: partId }, data: partData });
    } else {
      // Generated numbers are allocated under the numbering lock the caller holds, which
      // is what keeps a 5,000-row burst from colliding on scan-max.
      const partNumber = wanted === '' ? await generatePartNumber(tx) : wanted;
      const created = await tx.part.create({
        data: {
          partNumber,
          ...partData,
          createdById: userId,
          revisions: { create: { revision: 'A', lifecycle: Lifecycle.IN_WORK, createdById: userId } },
        },
        select: { id: true },
      });
      partId = created.id;
    }
  }

  let manufacturerPartId: number | null = null;
  if (task.manufacturerId !== null) {
    const amlData = {
      ...(description !== undefined ? { description } : {}),
      ...(distributorName !== undefined ? { distributorName } : {}),
      ...(distributorPartNumber !== undefined ? { distributorPartNumber } : {}),
    };
    if (existingAml) {
      const updated = await tx.manufacturerPart.update({
        where: { id: existingAml.id },
        data: amlData,
        select: { id: true },
      });
      manufacturerPartId = updated.id;
    } else {
      const created = await tx.manufacturerPart.create({
        data: { manufacturerId: task.manufacturerId, partId, mpn, ...amlData },
        select: { id: true },
      });
      manufacturerPartId = created.id;
    }
  }

  await tx.catalogImportRow.update({
    where: { id: task.id },
    data: { status: CatalogRowStatus.COMMITTED, message: null, partId, manufacturerPartId },
  });
}

router.post(
  '/catalog-imports/:id/commit',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = bodyOf(req);
    const userId = currentUserId(req);

    const createMissingManufacturers =
      body.createMissingManufacturers === undefined
        ? false
        : requireBoolean(body.createMissingManufacturers, 'createMissingManufacturers');
    const updateExisting =
      body.updateExisting === undefined
        ? false
        : requireBoolean(body.updateExisting, 'updateExisting');

    const record = await getImportOrThrow(id);
    if (record.status !== CatalogImportStatus.VALIDATED) {
      throw new HttpError(409, 'Validate the import before committing');
    }

    // INVALID, DUPLICATE and SKIPPED rows are never written (rule V4).
    const eligibleStatuses = updateExisting
      ? [CatalogRowStatus.NEW, CatalogRowStatus.UPDATE]
      : [CatalogRowStatus.NEW];

    // Claim the import before reading its rows. The status check above is a bare read, so
    // without this two overlapping commits both passed it and both wrote, and a validate
    // running mid-commit erased the audit links the commit was writing. The conditional
    // updateMany is the claim: exactly one caller can move VALIDATED -> COMMITTING.
    const claimed = await prisma.catalogImport.updateMany({
      where: { id, status: CatalogImportStatus.VALIDATED },
      data: { status: CatalogImportStatus.COMMITTING },
    });
    if (claimed.count === 0) {
      throw new HttpError(
        409,
        `${record.fileName} was changed concurrently — reload and try again`
      );
    }

    try {
    const rows = await prisma.catalogImportRow.findMany({
      where: { importId: id, status: { in: eligibleStatuses } },
      orderBy: { lineNumber: 'asc' },
      select: { id: true, lineNumber: true, mapped: true },
    });

    // Nothing to write is not a successful commit. Reporting COMMITTED here stamped
    // committedAt and froze the import permanently: validate, commit and delete all refuse a
    // committed import, so a file whose every row was already up to date became unusable.
    if (rows.length === 0) {
      await prisma.catalogImport.update({
        where: { id },
        data: { status: CatalogImportStatus.VALIDATED, error: null },
      });
      throw new HttpError(
        409,
        updateExisting
          ? 'No rows are eligible to commit — every row is invalid, duplicate or skipped'
          : 'No new rows to commit — turn on amending existing parts, or un-skip some rows'
      );
    }

    const failures: { id: number; lineNumber: number; message: string }[] = [];
    const tasks: CommitTask[] = [];
    const index = await loadManufacturerIndex();

    // Manufacturers are resolved (and optionally created) before the first chunk opens, so
    // the predictable failure — an unknown vendor — is recorded per row instead of
    // poisoning a transaction that carries 99 healthy rows.
    const unknownNames = new Map<string, string>();
    const staged: { id: number; lineNumber: number; mapped: CatalogMappedRowDto; name: string }[] =
      [];
    for (const row of rows) {
      const mapped = mappedFromJson(row.mapped);
      if (!mapped) {
        failures.push({
          id: row.id,
          lineNumber: row.lineNumber,
          message: 'Row has no mapped data — re-validate the import',
        });
        continue;
      }
      const manufacturerName = (mapped.manufacturerName ?? '').trim();
      if (manufacturerName !== '' && !index.has(nameKey(manufacturerName))) {
        unknownNames.set(nameKey(manufacturerName), manufacturerName);
      }
      staged.push({
        id: row.id,
        lineNumber: row.lineNumber,
        mapped,
        name: manufacturerName,
      });
    }

    if (createMissingManufacturers) {
      for (const [key, manufacturerName] of unknownNames) {
        try {
          const created = await prisma.manufacturer.create({
            data: { name: manufacturerName },
            select: { id: true },
          });
          index.set(key, created.id);
        } catch (err) {
          // A concurrent import may have created it first; adopt theirs.
          // Same reason as the AML lookup: an unescaped ILIKE would let a `%` or `_` in a
          // manufacturer name match the wrong company.
          const existing = (
            await prisma.$queryRaw<{ id: number }[]>`
              SELECT id FROM "Manufacturer" WHERE lower(name) = lower(${manufacturerName}) LIMIT 1`
          )[0];
          if (existing) index.set(key, existing.id);
          else console.error('Failed to create manufacturer during catalog commit', err);
        }
      }
    }

    for (const row of staged) {
      // No manufacturer in the file means no AML entry to make: rule V1 says a row becomes
      // *up to* three records, so such a row still yields its Part.
      const manufacturerId = row.name === '' ? null : (index.get(nameKey(row.name)) ?? null);
      if (row.name !== '' && manufacturerId === null) {
        failures.push({
          id: row.id,
          lineNumber: row.lineNumber,
          message: `Manufacturer "${row.name}" does not exist — commit with createMissingManufacturers to create it`,
        });
        continue;
      }
      tasks.push({
        id: row.id,
        lineNumber: row.lineNumber,
        mapped: row.mapped,
        manufacturerId,
      });
    }

    let committed = 0;
    for (let start = 0; start < tasks.length; start += COMMIT_CHUNK) {
      const chunk = tasks.slice(start, start + COMMIT_CHUNK);
      try {
        await withNumberLock(async (tx) => {
          for (const task of chunk) await commitRow(tx, task, userId, aclUser(req));
        });
        committed += chunk.length;
      } catch {
        // Postgres aborts the whole transaction on the first failing statement, so a chunk
        // cannot simply skip a bad row and carry on — nothing in it landed. Replay the chunk
        // one transaction per row to isolate the offender and let its siblings through.
        for (const task of chunk) {
          try {
            await withNumberLock((tx) => commitRow(tx, task, userId, aclUser(req)));
            committed += 1;
          } catch (err) {
            failures.push({ id: task.id, lineNumber: task.lineNumber, message: errorMessage(err) });
          }
        }
      }
    }

    // A failed row keeps its NEW/UPDATE status and carries the reason, so the preview shows
    // exactly what did not land and a later run can retry it.
    for (let start = 0; start < failures.length; start += VALIDATE_CHUNK) {
      const chunk = failures.slice(start, start + VALIDATE_CHUNK);
      await prisma.$transaction(
        chunk.map((failure) =>
          prisma.catalogImportRow.update({
            where: { id: failure.id },
            data: { message: failure.message },
          })
        )
      );
    }

    const counts = await countRowsByStatus(id);
    const allLanded = failures.length === 0;
    // Partial success is reported as COMMITTED with a non-zero failedCount (rule V4); only a
    // commit where nothing at all landed is FAILED.
    const status =
      allLanded || committed > 0 ? CatalogImportStatus.COMMITTED : CatalogImportStatus.FAILED;
    const first = failures[0];
    await prisma.catalogImport.update({
      where: { id },
      data: {
        ...countData(counts),
        failedCount: failures.length,
        status,
        // The summary carries one concrete reason: "3 rows failed" alone sends the user
        // hunting through the preview for the why.
        error: first
          ? `${failures.length} of ${failures.length + committed} eligible rows failed to commit — line ${first.lineNumber}: ${first.message}`
          : null,
        committedAt: status === CatalogImportStatus.COMMITTED ? new Date() : null,
      },
    });

      res.json(await getImportDetailOrThrow(id));
    } catch (err) {
      // The claim already moved this import out of VALIDATED. Leaving it in COMMITTING would
      // strand it — validate, commit and delete all refuse that state — so an unexpected
      // failure is recorded as FAILED, which the user can delete or re-validate.
      if (!(err instanceof HttpError)) {
        await prisma.catalogImport
          .update({
            where: { id },
            data: { status: CatalogImportStatus.FAILED, error: errorMessage(err).slice(0, 500) },
          })
          .catch((nested) => console.error('Could not record commit failure', nested));
      }
      throw err;
    }
  })
);

// ---------------------------------------------------------------------------
// GET /catalog-imports/:id/rows — the preview, paged and filterable by status
// ---------------------------------------------------------------------------

router.get(
  '/catalog-imports/:id/rows',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const record = await prisma.catalogImport.findUnique({ where: { id }, select: { id: true } });
    if (!record) throw new HttpError(404, 'Catalog import not found');

    const where: Prisma.CatalogImportRowWhereInput = { importId: id };
    const statusRaw = req.query.status;
    if (statusRaw !== undefined && statusRaw !== '') {
      if (
        typeof statusRaw !== 'string' ||
        !(Object.values(CatalogRowStatus) as string[]).includes(statusRaw)
      ) {
        throw new HttpError(400, 'Invalid status filter');
      }
      where.status = statusRaw as CatalogRowStatus;
    }

    const [total, rows] = await Promise.all([
      prisma.catalogImportRow.count({ where }),
      prisma.catalogImportRow.findMany({
        where,
        orderBy: { lineNumber: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: importRowInclude,
      }),
    ]);

    const payload: PagedDto<CatalogImportRowDto> = {
      items: rows.map(toImportRow),
      total,
      page,
      pageSize,
    };
    res.json(payload);
  })
);

// ---------------------------------------------------------------------------
// PATCH /catalog-import-rows/:id — per-row skip / un-skip in the preview
// ---------------------------------------------------------------------------

router.patch(
  '/catalog-import-rows/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = bodyOf(req);

    const existing = await prisma.catalogImportRow.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        import: { select: { id: true, fileName: true, status: true } },
      },
    });
    if (!existing) throw new HttpError(404, 'Import row not found');
    if (existing.import.status === CatalogImportStatus.COMMITTED) {
      throw new HttpError(409, `${existing.import.fileName} is committed and cannot be changed`);
    }
    if (existing.status === CatalogRowStatus.COMMITTED) {
      throw new HttpError(409, 'A committed row cannot be changed');
    }

    const statusRaw = body.status;
    if (
      typeof statusRaw !== 'string' ||
      (statusRaw !== CatalogRowStatus.SKIPPED && statusRaw !== CatalogRowStatus.NEW)
    ) {
      throw new HttpError(400, 'status must be SKIPPED or NEW');
    }

    // Un-skipping must RESTORE the row's real classification, not assume NEW. Trusting the
    // client's 'NEW' turned every un-skipped UPDATE row into a create, so a commit with
    // "amend existing" off still overwrote the existing part — the precise write that toggle
    // promises not to do. The server therefore re-derives it, which is also correct if the
    // underlying data changed since validation.
    let nextStatus = statusRaw as CatalogRowStatus;
    if (nextStatus === CatalogRowStatus.NEW) {
      const row = await prisma.catalogImportRow.findUnique({
        where: { id },
        select: { mapped: true },
      });
      const mapped = (row?.mapped ?? null) as CatalogMappedRowDto | null;
      if (mapped) {
        const invalid = classifyRow(mapped);
        if (!invalid.ok) {
          nextStatus = CatalogRowStatus.INVALID;
        } else if (mapped.manufacturerName && mapped.mpn) {
          const manufacturerId = (
            await prisma.$queryRaw<{ id: number }[]>`
              SELECT id FROM "Manufacturer"
              WHERE lower(name) = lower(${mapped.manufacturerName}) LIMIT 1`
          )[0]?.id;
          if (manufacturerId !== undefined) {
            const existing = await findExistingMpnKeys([manufacturerId], [nameKey(mapped.mpn)]);
            if (existing.size > 0) nextStatus = CatalogRowStatus.UPDATE;
          }
        }
      }
    }

    const updated = await prisma.catalogImportRow.update({
      where: { id },
      data: { status: nextStatus, message: null },
      include: importRowInclude,
    });

    // The import's counters must follow the row, or the commit summary lies about how many
    // rows are about to be written.
    const counts = await countRowsByStatus(existing.import.id);
    await prisma.catalogImport.update({
      where: { id: existing.import.id },
      data: countData(counts),
    });

    res.json(toImportRow(updated));
  })
);

// ---------------------------------------------------------------------------
// Catalog mappings (rule V5)
// ---------------------------------------------------------------------------

router.get(
  '/catalog-mappings',
  asyncHandler(async (_req, res) => {
    const mappings = await prisma.catalogMapping.findMany({
      orderBy: { name: 'asc' },
      include: mappingInclude,
    });
    res.json(mappings.map(toMapping));
  })
);

router.post(
  '/catalog-mappings',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const body = bodyOf(req);
    const name = requireName(body.name);

    // Saving the mapping used for an import is the normal route to a house mapping, so the
    // import supplies every field the user did not type.
    let seedFormat: CatalogFormat | undefined;
    let seedVendor: string | null = null;
    let seedFieldMap: FieldMap | undefined;
    let seedDefaults: FieldMap | undefined;
    let seedSignature: string[] | undefined;
    if (body.fromImportId !== undefined && body.fromImportId !== null) {
      const importId = requirePositiveInt(body.fromImportId, 'fromImportId');
      const source = await prisma.catalogImport.findUnique({
        where: { id: importId },
        select: {
          format: true,
          detectedVendor: true,
          sourceColumns: true,
          appliedFieldMap: true,
          appliedDefaults: true,
          mapping: { select: { fieldMap: true, defaults: true } },
        },
      });
      if (!source) throw new HttpError(404, 'Catalog import not found');
      seedFormat = source.format;
      seedVendor = source.detectedVendor;
      seedSignature = source.sourceColumns;
      // The mapping actually applied wins: a hand-built one is the case worth saving, and
      // before it was recorded this could only ever recover an already-saved mapping.
      const applied = fieldMapFromJson(source.appliedFieldMap);
      if (Object.keys(applied).length > 0) {
        seedFieldMap = applied;
        seedDefaults = fieldMapFromJson(source.appliedDefaults);
      } else if (source.mapping) {
        seedFieldMap = fieldMapFromJson(source.mapping.fieldMap);
        seedDefaults = fieldMapFromJson(source.mapping.defaults);
      }
    }

    const fieldMap =
      body.fieldMap !== undefined ? requireFieldMap(body.fieldMap, 'fieldMap') : seedFieldMap;
    if (!fieldMap || Object.keys(fieldMap).length === 0) {
      throw new HttpError(400, 'fieldMap is required');
    }
    const defaults =
      body.defaults === undefined
        ? seedDefaults
        : body.defaults === null
          ? undefined
          : requireFieldMap(body.defaults, 'defaults');
    const format =
      body.format === undefined ? (seedFormat ?? CatalogFormat.CSV) : requireFormat(body.format);
    const vendor =
      body.vendor === undefined ? seedVendor : optionalNullableText(body.vendor, 'vendor');
    const headerSignature =
      body.headerSignature === undefined
        ? (seedSignature ?? [])
        : requireStringArray(body.headerSignature, 'headerSignature');

    const clash = await prisma.catalogMapping.findUnique({ where: { name }, select: { id: true } });
    if (clash) throw new HttpError(409, `Mapping "${name}" already exists`);

    const created = await prisma.catalogMapping.create({
      data: {
        name,
        vendor,
        format,
        fieldMap: asJson(fieldMap),
        defaults: defaults && Object.keys(defaults).length > 0 ? asJson(defaults) : undefined,
        headerSignature,
        builtIn: false,
        createdById: userId,
      },
      include: mappingInclude,
    });
    res.status(201).json(toMapping(created));
  })
);

router.patch(
  '/catalog-mappings/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = bodyOf(req);

    const existing = await prisma.catalogMapping.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'Catalog mapping not found');
    if (existing.builtIn) throw new HttpError(409, `${existing.name} is a built-in mapping`);

    const data: Prisma.CatalogMappingUpdateInput = {};
    if (body.name !== undefined) {
      const name = requireName(body.name);
      if (name !== existing.name) {
        const clash = await prisma.catalogMapping.findUnique({
          where: { name },
          select: { id: true },
        });
        if (clash) throw new HttpError(409, `Mapping "${name}" already exists`);
      }
      data.name = name;
    }
    if (body.vendor !== undefined) data.vendor = optionalNullableText(body.vendor, 'vendor');
    if (body.format !== undefined) data.format = requireFormat(body.format);
    if (body.fieldMap !== undefined) {
      const fieldMap = requireFieldMap(body.fieldMap, 'fieldMap');
      if (Object.keys(fieldMap).length === 0) throw new HttpError(400, 'fieldMap is required');
      data.fieldMap = asJson(fieldMap);
    }
    if (body.defaults !== undefined) {
      const defaults =
        body.defaults === null ? null : requireFieldMap(body.defaults, 'defaults');
      data.defaults =
        defaults && Object.keys(defaults).length > 0 ? asJson(defaults) : Prisma.JsonNull;
    }
    if (body.headerSignature !== undefined) {
      data.headerSignature = requireStringArray(body.headerSignature, 'headerSignature');
    }

    const updated = await prisma.catalogMapping.update({
      where: { id },
      data,
      include: mappingInclude,
    });
    res.json(toMapping(updated));
  })
);

router.delete(
  '/catalog-mappings/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const existing = await prisma.catalogMapping.findUnique({
      where: { id },
      select: { id: true, name: true, builtIn: true },
    });
    if (!existing) throw new HttpError(404, 'Catalog mapping not found');
    if (existing.builtIn) throw new HttpError(409, `${existing.name} is a built-in mapping`);
    await prisma.catalogMapping.delete({ where: { id } });
    res.status(204).end();
  })
);

/**
 * Seed the built-in vendor presets (rule V5). Upserted by name, so calling it on every boot
 * refreshes the shipped signatures without ever duplicating a preset or touching a mapping
 * a user created.
 */
export async function seedCatalogMappings(): Promise<void> {
  for (const preset of BUILT_IN_MAPPINGS) {
    const shared = {
      vendor: preset.vendor,
      format: preset.format,
      fieldMap: asJson(preset.fieldMap),
      defaults: preset.defaults ? asJson(preset.defaults) : Prisma.JsonNull,
      headerSignature: preset.headerSignature,
      builtIn: true,
    };
    await prisma.catalogMapping.upsert({
      where: { name: preset.name },
      update: shared,
      create: { name: preset.name, ...shared },
    });
  }
}

export default router;
