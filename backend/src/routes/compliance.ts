/**
 * Substance compliance: the reference list, a part's declarations, and the assembly roll-up.
 *
 * The roll-up is the feature. Everything above it exists to feed it, and it answers one
 * question: can this assembly, as it is built, be claimed compliant with a regulation? The
 * output is what somebody puts their name to on a declaration of conformity, so it is written
 * against one specific lie:
 *
 *   AN ASSEMBLY IS COMPLIANT ONLY IF EVERY CONTRIBUTOR IS COMPLIANT OR EXEMPT. One UNKNOWN
 *   child makes the assembly UNKNOWN — not compliant, and not non-compliant.
 *
 * "Nobody has told us" is the most common real state in any part master that has not been
 * through a full declaration campaign, and it is the state every other tool rounds up to
 * green, because green is what the screen is for. This codebase already refuses that shape of
 * answer everywhere it has come up — the cost roll-up nulls a total rather than reporting a
 * smaller one, lib/whereUsed.ts keeps a restricted row and strips it rather than dropping it —
 * and this is the highest stakes place to hold the line, because the number downstream of it
 * is a legal statement rather than a figure somebody sanity-checks.
 *
 * A status on its own is also not enough to act on, so the response carries, per regulation,
 * the parts that produced it, how old the oldest evidence is, how many contributors are hidden
 * from this caller, and any exemption that has expired.
 */
import { Request, Router } from 'express';
import { ComplianceStatus, Lifecycle, Prisma, Regulation } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { resolveDisplayRevision } from '../lib/plm';
import { notifyUsers } from '../lib/notify';
import {
  AclUser,
  aclFilter,
  assertCanRead,
  assertCanWrite,
  REDACTED,
  visibleIds,
} from '../lib/acl';

const router = Router();
router.use(requireAuth);

/**
 * Same cap as the BOM tree, the cost roll-up and the where-used walk, so every traversal in
 * this product agrees about how deep a product can be before the answer is truncated.
 */
const MAX_TREE_DEPTH = 15;

/** Every regulation, in a fixed order, because the response reports all of them always. */
const REGULATIONS: Regulation[] = [
  Regulation.ROHS,
  Regulation.REACH_SVHC,
  Regulation.PFAS,
  Regulation.PROP65,
  Regulation.CONFLICT_MINERALS,
  Regulation.TSCA,
];

// ---------------------------------------------------------------------------
// Response DTO shapes
// ---------------------------------------------------------------------------

interface PartRefDto {
  id: number;
  partNumber: string;
  name: string;
}

interface UserRefDto {
  id: number;
  name: string;
}

/**
 * The evidence document, or the fact that there is one and this caller may not read it.
 *
 * Same convention as `REDACTED` in lib/acl.ts and the redacted rows in lib/whereUsed.ts: the
 * row stays, the identity goes. Omitting the field entirely would tell a caller their
 * declaration has no evidence behind it when it has, which is a worse answer than "Restricted".
 */
interface DocumentRefDto {
  id: number | null;
  docNumber: string;
  title: string;
  redacted?: true;
}

interface SubstanceDto {
  id: number;
  name: string;
  casNumber: string | null;
  regulation: Regulation;
  /** A null threshold is NOT zero — the regulation sets none, or we do not record one. */
  thresholdPpm: number | null;
  notes: string | null;
  /** How many parts declare it. What makes the delete refusal below explicable on screen. */
  partCount: number;
  createdAt: string;
}

interface PartComplianceDto {
  /** Null when nothing has been declared for this regulation yet. */
  id: number | null;
  regulation: Regulation;
  /**
   * UNKNOWN where `declared` is false. The two are reported separately on purpose: a stored
   * UNKNOWN is somebody saying "we asked and nobody could tell us", and an absent row is
   * nobody having asked. They roll up identically and they are not the same fact.
   */
  status: ComplianceStatus;
  declared: boolean;
  evidenceDocument: DocumentRefDto | null;
  declaredAt: string | null;
  expiresAt: string | null;
  declaredBy: UserRefDto | null;
  notes: string | null;
  updatedAt: string | null;
}

interface PartSubstanceDto {
  id: number;
  substance: SubstanceDto;
  ppm: number | null;
  exemptionCode: string | null;
  notes: string | null;
  declaredAt: string;
  declaredBy: UserRefDto | null;
}

interface PartComplianceViewDto {
  part: PartRefDto;
  /** One entry per regulation, declared or not. See `declared` above. */
  compliances: PartComplianceDto[];
  substances: PartSubstanceDto[];
}

interface ExpiredDeclarationDto {
  part: PartRefDto;
  /** Carried, because an expired EXEMPT and an expired COMPLIANT are different problems. */
  status: ComplianceStatus;
  expiresAt: string;
}

interface RegulationRollupDto {
  regulation: Regulation;
  status: ComplianceStatus;
  counts: {
    compliant: number;
    nonCompliant: number;
    exempt: number;
    unknown: number;
    /**
     * A SUBSET of `unknown`: contributors this caller may not read, counted and not named
     * (rule X4). Reported separately so a shorter `unknownParts` list than `unknown` count is
     * explained rather than looking like a bug.
     */
    redacted: number;
  };
  /** The actionable lists. A status with no "which parts" cannot be worked. */
  nonCompliantParts: PartRefDto[];
  unknownParts: PartRefDto[];
  /** Declarations whose `expiresAt` has passed. Reported, never silently reclassified. */
  expired: ExpiredDeclarationDto[];
  /** The oldest `declaredAt` among contributors. A 2019 declaration is a fact about 2019. */
  oldestEvidenceAt: string | null;
  /**
   * Contributors whose declaration carries no date at all. Without this, `oldestEvidenceAt`
   * reads as "the oldest evidence here" when it is only the oldest evidence that was dated.
   */
  undatedEvidenceCount: number;
}

interface ComplianceRollupDto {
  part: PartRefDto;
  /** The revision the structure was walked from; null when the part has no revisions. */
  revision: { id: number; revision: string; lifecycle: Lifecycle } | null;
  /** Distinct parts reached, including the part asked about. */
  partsExamined: number;
  /** Distinct parts reached that this caller may not read. */
  redactedCount: number;
  /** True when the walk stopped early. A truncated roll-up shown as complete is the worst case. */
  truncated: boolean;
  regulations: RegulationRollupDto[];
  notes: string[];
}

interface SeedResultDto {
  created: number;
  skipped: number;
  items: SubstanceDto[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// The canonical starting list — reference data nobody should have to type
// ---------------------------------------------------------------------------

/**
 * `Substance` is reference data ("lead is lead") held in an ordinary table that anybody with
 * admin rights can type into. That is the hazard this list exists to reduce: entries typed by
 * hand invent CAS numbers and thresholds for substances that already have them, and
 * declarations made against an invented identifier cannot be compared with anybody else's.
 * `@@unique([regulation, name])` stops two rows sharing a name; it cannot make either right.
 *
 * SO THERE IS A CANONICAL STARTING LIST, INSTALLED BY AN EXPLICIT ADMIN CALL
 * (`POST /substances/seed-defaults`). The three alternatives and why each was rejected:
 *
 *  - **Seed on the first read of `/substances`.** Rejected: a GET that writes is not a read.
 *    `requireWriteRole` lets every authenticated VIEWER and every read-scoped API key issue
 *    GETs, so the first viewer to open the screen would install reference data, and
 *    `auditMiddleware` does not record GETs — nothing would say who did it or when. Concurrent
 *    first reads also race on `@@unique([regulation, name])`, so one of them fails a page
 *    load. And it makes the list un-emptiable: a team that deliberately deletes an entry it
 *    does not track gets it back on the next page load with nothing to explain why.
 *  - **Seed at install time, from a migration or a seed script.** Rejected: a data migration
 *    names no person, is not audited and cannot be refused — it would arrive before anybody
 *    had decided they wanted it, on every deployment including the ones that keep their own
 *    list.
 *  - **Leave it manual.** Leaves the hazard above exactly where it is.
 *
 * An admin-called endpoint is attributable, audited, idempotent, and refusable. It is also the
 * one shape a deployment that keeps its own list can simply never call.
 *
 * WHAT THIS LIST IS NOT: a reproduction of any regulation. RoHS Annex II is complete here
 * because it is ten entries fixed in law; the REACH SVHC candidate list is ~250 entries
 * revised twice a year, and shipping a snapshot of it as if it were complete would make an
 * incomplete declaration look complete — the exact failure this module exists to prevent. So
 * those entries are a labelled starting point. Thresholds are recorded ONLY where the
 * regulation states a single ppm figure; elsewhere the threshold is null, and a null threshold
 * is not zero. A CAS number is recorded only where there is one: a substance GROUP has none,
 * and inventing one is the error the shared list exists to stop.
 */
interface SeedSubstance {
  name: string;
  regulation: Regulation;
  casNumber: string | null;
  thresholdPpm: number | null;
  notes: string | null;
}

const GROUP_NO_CAS = 'Substance group — no single CAS number.';
const SVHC_STARTER =
  'Starter entry. The SVHC candidate list is revised twice a year and is not reproduced here.';
const PROP65_NO_THRESHOLD =
  'Proposition 65 sets no ppm threshold — exposure is assessed against a safe-harbour level.';
const TG_3TG = 'Declarable at any concentration; reported by smelter rather than by ppm.';
const TSCA_CONFIRM = 'Threshold not recorded here — confirm against the current TSCA rule.';

const DEFAULT_SUBSTANCES: SeedSubstance[] = [
  // RoHS Annex II, all ten, with the restriction limits the directive states.
  { name: 'Lead', regulation: Regulation.ROHS, casNumber: '7439-92-1', thresholdPpm: 1000, notes: null },
  { name: 'Mercury', regulation: Regulation.ROHS, casNumber: '7439-97-6', thresholdPpm: 1000, notes: null },
  { name: 'Cadmium', regulation: Regulation.ROHS, casNumber: '7440-43-9', thresholdPpm: 100, notes: null },
  {
    name: 'Hexavalent chromium',
    regulation: Regulation.ROHS,
    casNumber: '18540-29-9',
    thresholdPpm: 1000,
    notes: null,
  },
  {
    name: 'Polybrominated biphenyls (PBB)',
    regulation: Regulation.ROHS,
    casNumber: null,
    thresholdPpm: 1000,
    notes: GROUP_NO_CAS,
  },
  {
    name: 'Polybrominated diphenyl ethers (PBDE)',
    regulation: Regulation.ROHS,
    casNumber: null,
    thresholdPpm: 1000,
    notes: GROUP_NO_CAS,
  },
  {
    name: 'Bis(2-ethylhexyl) phthalate (DEHP)',
    regulation: Regulation.ROHS,
    casNumber: '117-81-7',
    thresholdPpm: 1000,
    notes: null,
  },
  {
    name: 'Butyl benzyl phthalate (BBP)',
    regulation: Regulation.ROHS,
    casNumber: '85-68-7',
    thresholdPpm: 1000,
    notes: null,
  },
  {
    name: 'Dibutyl phthalate (DBP)',
    regulation: Regulation.ROHS,
    casNumber: '84-74-2',
    thresholdPpm: 1000,
    notes: null,
  },
  {
    name: 'Diisobutyl phthalate (DIBP)',
    regulation: Regulation.ROHS,
    casNumber: '84-69-5',
    thresholdPpm: 1000,
    notes: null,
  },

  // REACH SVHC — a labelled starting point, not the candidate list. 1000 ppm is the 0.1 % w/w
  // figure the notification duty for articles is stated against.
  {
    name: 'Lead',
    regulation: Regulation.REACH_SVHC,
    casNumber: '7439-92-1',
    thresholdPpm: 1000,
    notes: SVHC_STARTER,
  },
  {
    name: 'Bis(2-ethylhexyl) phthalate (DEHP)',
    regulation: Regulation.REACH_SVHC,
    casNumber: '117-81-7',
    thresholdPpm: 1000,
    notes: SVHC_STARTER,
  },
  {
    name: 'Boric acid',
    regulation: Regulation.REACH_SVHC,
    casNumber: '10043-35-3',
    thresholdPpm: 1000,
    notes: SVHC_STARTER,
  },
  {
    name: 'Diarsenic trioxide',
    regulation: Regulation.REACH_SVHC,
    casNumber: '1327-53-3',
    thresholdPpm: 1000,
    notes: SVHC_STARTER,
  },

  // PFAS — no single threshold: the limits differ by jurisdiction and by article, so none is
  // recorded rather than one being chosen on the customer's behalf.
  {
    name: 'Perfluorooctanoic acid (PFOA)',
    regulation: Regulation.PFAS,
    casNumber: '335-67-1',
    thresholdPpm: null,
    notes: 'Thresholds differ by jurisdiction; none recorded here.',
  },
  {
    name: 'Perfluorooctanesulfonic acid (PFOS)',
    regulation: Regulation.PFAS,
    casNumber: '1763-23-1',
    thresholdPpm: null,
    notes: 'Thresholds differ by jurisdiction; none recorded here.',
  },
  {
    name: 'Per- and polyfluoroalkyl substances (PFAS)',
    regulation: Regulation.PFAS,
    casNumber: null,
    thresholdPpm: null,
    notes: GROUP_NO_CAS,
  },

  { name: 'Lead', regulation: Regulation.PROP65, casNumber: '7439-92-1', thresholdPpm: null, notes: PROP65_NO_THRESHOLD },
  {
    name: 'Cadmium',
    regulation: Regulation.PROP65,
    casNumber: '7440-43-9',
    thresholdPpm: null,
    notes: PROP65_NO_THRESHOLD,
  },
  {
    name: 'Bis(2-ethylhexyl) phthalate (DEHP)',
    regulation: Regulation.PROP65,
    casNumber: '117-81-7',
    thresholdPpm: null,
    notes: PROP65_NO_THRESHOLD,
  },

  // The 3TG metals.
  { name: 'Tantalum', regulation: Regulation.CONFLICT_MINERALS, casNumber: '7440-25-7', thresholdPpm: null, notes: TG_3TG },
  { name: 'Tin', regulation: Regulation.CONFLICT_MINERALS, casNumber: '7440-31-5', thresholdPpm: null, notes: TG_3TG },
  { name: 'Tungsten', regulation: Regulation.CONFLICT_MINERALS, casNumber: '7440-33-7', thresholdPpm: null, notes: TG_3TG },
  { name: 'Gold', regulation: Regulation.CONFLICT_MINERALS, casNumber: '7440-57-5', thresholdPpm: null, notes: TG_3TG },

  {
    name: 'Decabromodiphenyl ether (DecaBDE)',
    regulation: Regulation.TSCA,
    casNumber: '1163-19-5',
    thresholdPpm: null,
    notes: TSCA_CONFIRM,
  },
  {
    name: 'Polychlorinated biphenyls (PCB)',
    regulation: Regulation.TSCA,
    casNumber: '1336-36-3',
    thresholdPpm: null,
    notes: TSCA_CONFIRM,
  },
  {
    name: 'Phenol, isopropylated phosphate (3:1) (PIP (3:1))',
    regulation: Regulation.TSCA,
    casNumber: null,
    thresholdPpm: null,
    notes: `CAS number not recorded in this starter list. ${TSCA_CONFIRM}`,
  },
];

// ---------------------------------------------------------------------------
// Request helpers — the same shapes routes/materials.ts uses
// ---------------------------------------------------------------------------

function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function currentUserId(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user.id;
}

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function partAcl(user: AclUser): Prisma.PartWhereInput {
  return aclFilter('PART', user) as Prisma.PartWhereInput;
}

function requireText(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim().slice(0, max);
}

/** Absent and explicitly-null both mean "no value"; only a wrong type is an error. */
function optionalText(value: unknown, field: string, max = 1000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string or null`);
  return value.trim().slice(0, max) || null;
}

/**
 * A concentration or a threshold. Negative is refused here as well as by the CHECK constraints
 * the migration adds, so the caller gets a message naming the field rather than a 500 from
 * Postgres — the database remains the enforcement, this is the error text.
 */
function optionalPpm(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new HttpError(400, `${field} must be a number >= 0 or null`);
  }
  return value;
}

function parseEnumValue<T extends Record<string, string>>(
  value: unknown,
  values: T,
  field: string
): T[keyof T] {
  if (typeof value !== 'string' || !Object.values(values).includes(value)) {
    throw new HttpError(400, `${field} must be one of ${Object.values(values).join(', ')}`);
  }
  return value as T[keyof T];
}

/**
 * An ISO date, or null. Deliberately strict: `new Date('soon')` is an Invalid Date that Prisma
 * rejects with a 500, and a declaration date is the field the roll-up's evidence age is
 * computed from — a silently wrong one would date somebody's evidence by accident.
 */
function optionalDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new HttpError(400, `${field} must be an ISO date string or null`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(400, `${field} is not a valid date`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const substanceSelect = {
  id: true,
  name: true,
  casNumber: true,
  regulation: true,
  thresholdPpm: true,
  notes: true,
  createdAt: true,
  _count: { select: { parts: true } },
} satisfies Prisma.SubstanceSelect;

type SubstanceRow = Prisma.SubstanceGetPayload<{ select: typeof substanceSelect }>;

function toSubstance(row: SubstanceRow): SubstanceDto {
  return {
    id: row.id,
    name: row.name,
    casNumber: row.casNumber,
    regulation: row.regulation,
    thresholdPpm: row.thresholdPpm,
    notes: row.notes,
    partCount: row._count.parts,
    createdAt: row.createdAt.toISOString(),
  };
}

function toPartRef(part: { id: number; partNumber: string; name: string }): PartRefDto {
  return { id: part.id, partNumber: part.partNumber, name: part.name };
}

function toUserRef(user: { id: number; name: string } | null): UserRefDto | null {
  return user ? { id: user.id, name: user.name } : null;
}

async function getSubstanceOrThrow(id: number): Promise<SubstanceRow> {
  const row = await prisma.substance.findUnique({ where: { id }, select: substanceSelect });
  if (!row) throw new HttpError(404, 'Substance not found');
  return row;
}

// ---------------------------------------------------------------------------
// GET /substances, POST /substances, PATCH, DELETE
// ---------------------------------------------------------------------------

router.get(
  '/substances',
  asyncHandler(async (req, res) => {
    const regulation =
      typeof req.query.regulation === 'string' && req.query.regulation !== ''
        ? parseEnumValue(req.query.regulation, Regulation, 'regulation')
        : undefined;
    const rows = await prisma.substance.findMany({
      where: regulation ? { regulation } : {},
      orderBy: [{ regulation: 'asc' }, { name: 'asc' }],
      select: substanceSelect,
    });
    res.json(rows.map(toSubstance));
  })
);

router.post(
  '/substances',
  asyncHandler(async (req, res) => {
    const body = bodyOf(req);
    const name = requireText(body.name, 'name');
    const regulation = parseEnumValue(body.regulation, Regulation, 'regulation');
    try {
      const created = await prisma.substance.create({
        data: {
          name,
          regulation,
          casNumber: optionalText(body.casNumber, 'casNumber', 32),
          thresholdPpm: optionalPpm(body.thresholdPpm, 'thresholdPpm'),
          notes: optionalText(body.notes, 'notes'),
        },
        select: substanceSelect,
      });
      res.status(201).json(toSubstance(created));
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        // `@@unique([regulation, name])` is the only thing keeping declarations comparable
        // with each other, so the collision is reported rather than merged into the existing
        // row: merging would silently adopt whatever threshold and CAS number were already
        // there.
        throw new HttpError(409, `${name} is already recorded for ${regulation}`);
      }
      throw err;
    }
  })
);

/**
 * Install the canonical starting list. ADMIN only, idempotent, and it reports what it did.
 *
 * `skipDuplicates` leans on `@@unique([regulation, name])`, so calling this twice adds nothing
 * and calling it where somebody already types their own entries cannot overwrite one of them.
 * 200 rather than 201 because the honest answer to a second call is "created: 0".
 *
 * Admin rather than engineer because this is reference data every declaration in the database
 * is then compared against — the same reasoning that makes attribute definitions admin-only
 * (rule T9).
 */
router.post(
  '/substances/seed-defaults',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const before = await prisma.substance.count();
    const result = await prisma.substance.createMany({
      data: DEFAULT_SUBSTANCES.map((entry) => ({
        name: entry.name,
        regulation: entry.regulation,
        casNumber: entry.casNumber,
        thresholdPpm: entry.thresholdPpm,
        notes: entry.notes,
      })),
      skipDuplicates: true,
    });
    const items = await prisma.substance.findMany({
      orderBy: [{ regulation: 'asc' }, { name: 'asc' }],
      select: substanceSelect,
    });
    const payload: SeedResultDto = {
      created: result.count,
      skipped: DEFAULT_SUBSTANCES.length - result.count,
      items: items.map(toSubstance),
      notes: [
        `Installed ${result.count} of ${DEFAULT_SUBSTANCES.length} starting entries; ` +
          `${before} were already on file.`,
        'RoHS Annex II is complete. The REACH SVHC entries are a starting point, not the ' +
          'candidate list, which is revised twice a year — confirm against ECHA before ' +
          'declaring against it.',
        'A null threshold is not zero: it means the regulation states no single ppm figure, ' +
          'or that this list does not record one.',
      ],
    };
    res.json(payload);
  })
);

router.patch(
  '/substances/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const existing = await getSubstanceOrThrow(id);
    const body = bodyOf(req);

    const data: Prisma.SubstanceUncheckedUpdateInput = {};
    if (body.name !== undefined) data.name = requireText(body.name, 'name');
    if (body.casNumber !== undefined) {
      data.casNumber = optionalText(body.casNumber, 'casNumber', 32);
    }
    if (body.thresholdPpm !== undefined) {
      data.thresholdPpm = optionalPpm(body.thresholdPpm, 'thresholdPpm');
    }
    if (body.notes !== undefined) data.notes = optionalText(body.notes, 'notes');
    if (body.regulation !== undefined) {
      const regulation = parseEnumValue(body.regulation, Regulation, 'regulation');
      // Re-pointing a substance at another regulation would move every declaration already
      // made against it, retroactively and silently — the row is what a PartSubstance means.
      // Echoing the current value is allowed so a client can PATCH the whole object back.
      if (regulation !== existing.regulation) {
        throw new HttpError(
          409,
          `A substance's regulation cannot be changed — ${existing.name} is declared on ` +
            `${existing._count.parts} part(s) under ${existing.regulation}. Create a new entry.`
        );
      }
    }

    try {
      const updated = await prisma.substance.update({
        where: { id },
        data,
        select: substanceSelect,
      });
      res.json(toSubstance(updated));
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new HttpError(409, `Another ${existing.regulation} entry already has that name`);
      }
      throw err;
    }
  })
);

router.delete(
  '/substances/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const substance = await getSubstanceOrThrow(id);
    if (substance._count.parts > 0) {
      /*
       * Refused, not cascaded.
       *
       * `PartSubstance.substanceId` is `onDelete: Cascade`, so deleting this row would take
       * every declaration naming it with no trace — the supplier declarations behind a
       * compliance claim, erased by tidying up a reference list. The count is in the message
       * because "it is in use" with no number is not actionable.
       */
      throw new HttpError(
        409,
        `${substance.name} is declared on ${substance._count.parts} part${
          substance._count.parts === 1 ? '' : 's'
        } — remove those declarations first`
      );
    }
    await prisma.substance.delete({ where: { id } });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// A part's declarations
// ---------------------------------------------------------------------------

const complianceSelect = {
  id: true,
  regulation: true,
  status: true,
  evidenceDocumentId: true,
  declaredAt: true,
  expiresAt: true,
  notes: true,
  updatedAt: true,
  declaredBy: { select: { id: true, name: true } },
  evidenceDocument: { select: { id: true, docNumber: true, title: true } },
} satisfies Prisma.PartComplianceSelect;

type ComplianceRow = Prisma.PartComplianceGetPayload<{ select: typeof complianceSelect }>;

const partSubstanceSelect = {
  id: true,
  ppm: true,
  exemptionCode: true,
  notes: true,
  declaredAt: true,
  declaredBy: { select: { id: true, name: true } },
  substance: { select: substanceSelect },
} satisfies Prisma.PartSubstanceSelect;

function toCompliance(row: ComplianceRow, evidenceVisible: boolean): PartComplianceDto {
  return {
    id: row.id,
    regulation: row.regulation,
    status: row.status,
    declared: true,
    evidenceDocument:
      row.evidenceDocument === null
        ? null
        : evidenceVisible
          ? {
              id: row.evidenceDocument.id,
              docNumber: row.evidenceDocument.docNumber,
              title: row.evidenceDocument.title,
            }
          : { id: null, docNumber: REDACTED.name, title: REDACTED.name, redacted: true },
    declaredAt: row.declaredAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    declaredBy: toUserRef(row.declaredBy),
    notes: row.notes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The shape for a regulation nobody has declared anything about. */
function undeclared(regulation: Regulation): PartComplianceDto {
  return {
    id: null,
    regulation,
    status: ComplianceStatus.UNKNOWN,
    declared: false,
    evidenceDocument: null,
    declaredAt: null,
    expiresAt: null,
    declaredBy: null,
    notes: null,
    updatedAt: null,
  };
}

/**
 * Every regulation, declared or not.
 *
 * The same choice rule T7 makes for custom attributes, and for a stronger reason here: a
 * screen that lists only the regulations with a row on them shows an empty card for a part
 * nobody has asked about, and an empty card reads as "nothing to worry about". Six rows of
 * UNKNOWN read as what they are.
 */
async function partComplianceView(partId: number, user: AclUser): Promise<PartComplianceViewDto> {
  const part = await prisma.part.findFirst({
    where: { id: partId, ...partAcl(user) },
    select: { id: true, partNumber: true, name: true },
  });
  if (!part) throw new HttpError(404, 'Part not found');

  const [rows, substances] = await Promise.all([
    prisma.partCompliance.findMany({ where: { partId }, select: complianceSelect }),
    prisma.partSubstance.findMany({
      where: { partId },
      orderBy: [{ substance: { regulation: 'asc' } }, { substance: { name: 'asc' } }],
      select: partSubstanceSelect,
    }),
  ]);

  /*
   * The evidence document is a DOCUMENT, with its own ACL, and it is not necessarily as
   * visible as the part that points at it. An unfiltered nested read is the leak lib/acl.ts
   * warns about by name ("include / select bypass it"), so the ids are resolved through
   * `visibleIds` and the invisible ones keep their row and lose their identity.
   */
  const evidenceIds = rows
    .map((row) => row.evidenceDocumentId)
    .filter((id): id is number => id !== null);
  const visibleDocs = await visibleIds('DOCUMENT', evidenceIds, user);

  const byRegulation = new Map(rows.map((row) => [row.regulation, row]));
  return {
    part: toPartRef(part),
    compliances: REGULATIONS.map((regulation) => {
      const row = byRegulation.get(regulation);
      if (!row) return undeclared(regulation);
      return toCompliance(
        row,
        row.evidenceDocumentId === null || visibleDocs.has(row.evidenceDocumentId)
      );
    }),
    substances: substances.map((row) => ({
      id: row.id,
      substance: toSubstance(row.substance),
      ppm: row.ppm,
      exemptionCode: row.exemptionCode,
      notes: row.notes,
      declaredAt: row.declaredAt.toISOString(),
      declaredBy: toUserRef(row.declaredBy),
    })),
  };
}

router.get(
  '/parts/:id/compliance',
  asyncHandler(async (req, res) => {
    res.json(await partComplianceView(idParam(req.params.id), aclUser(req)));
  })
);

/**
 * Who is told that a part has been declared NON_COMPLIANT, and who is not.
 *
 * IN-APP ONLY. `notifyUsers` is the entire delivery mechanism; nothing in this file goes near
 * lib/mailer.ts.
 *
 * Followers are candidates, not recipients. A follow proves somebody could read the part when
 * they clicked Follow, never that they still can — losing access does not delete the Watch row
 * — and the notification quotes the part number and the regulation. Same shape and same
 * primitive as `recipientsWhoCanRead` in routes/collab.ts and `recipientsWhoCanReadProject` in
 * routes/projects.ts: `visibleIds` is the filter the read paths use, so "may this person open
 * it" cannot drift between the page and the inbox.
 *
 * Resolved BEFORE the transaction, because who may be told is a read of the part's grants
 * rather than part of this write, and `visibleIds` resolves its delegate from the module-level
 * client and would escape the transaction onto another connection regardless.
 */
async function followersWhoCanRead(partId: number, actorId: number): Promise<number[]> {
  const followers = await prisma.watch.findMany({
    where: { partId },
    select: { user: { select: { id: true, role: true } } },
  });
  const candidates = followers.map((row) => row.user).filter((user) => user.id !== actorId);
  if (candidates.length === 0) return [];
  const allowed = await Promise.all(
    candidates.map(async (user) => (await visibleIds('PART', [partId], user)).has(partId))
  );
  return candidates.filter((_user, index) => allowed[index]).map((user) => user.id);
}

/**
 * PUT /parts/:id/compliance/:regulation — record (or re-record) one declaration.
 *
 * An expired `expiresAt` is accepted on purpose: recording a declaration that has already
 * lapsed is recording the truth, and the roll-up is what reports it. Refusing it would push
 * the real state out of the database and into somebody's spreadsheet.
 */
router.put(
  '/parts/:id/compliance/:regulation',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const user = aclUser(req);
    const actorId = currentUserId(req);
    // Access first, before any body validation: a 400 about a malformed status, raised ahead
        // of the access check, already tells the caller the part exists (rule X3).
    await assertCanWrite('PART', partId, user);
    const regulation = parseEnumValue(req.params.regulation, Regulation, 'regulation');

    const body = bodyOf(req);
    const status = parseEnumValue(body.status, ComplianceStatus, 'status');
    const notes = optionalText(body.notes, 'notes');
    const declaredAt = optionalDate(body.declaredAt, 'declaredAt');
    const expiresAt = optionalDate(body.expiresAt, 'expiresAt');

    let evidenceDocumentId: number | null = null;
    if (body.evidenceDocumentId !== undefined && body.evidenceDocumentId !== null) {
      evidenceDocumentId = idParam(String(body.evidenceDocumentId), 'evidenceDocumentId');
      // Through the DOCUMENT filter, and 404 like a missing one. Without this check a caller
      // could attach a document they may not read and then read its number and title back
      // out of GET /parts/:id/compliance — the leak by way of a write that rule X3 forbids.
      const document = await prisma.document.findFirst({
        where: { id: evidenceDocumentId, ...(aclFilter('DOCUMENT', user) as Prisma.DocumentWhereInput) },
        select: { id: true },
      });
      if (!document) throw new HttpError(404, 'Document not found');
    }

    const previous = await prisma.partCompliance.findFirst({
      where: { partId, regulation },
      select: { status: true },
    });
    /*
     * A declaration arriving at NON_COMPLIANT is the one state change somebody needs to hear
     * about: it is what stops a shipment. Resolved before the transaction (see
     * `followersWhoCanRead`), and only on a CHANGE — re-saving a row that already said
     * NON_COMPLIANT is an edit to the notes, not news.
     */
    const announce =
      status === ComplianceStatus.NON_COMPLIANT && previous?.status !== ComplianceStatus.NON_COMPLIANT;
    const recipients = announce ? await followersWhoCanRead(partId, actorId) : [];

    const part = await prisma.$transaction(async (tx) => {
      const data = {
        status,
        evidenceDocumentId,
        declaredAt,
        expiresAt,
        notes,
        declaredById: actorId,
      };
      /*
       * `updateMany` then `create`, and a lost race retried rather than reported.
       *
       * `updateMany` takes a non-unique filter, which is how every other query in this file
       * addresses a part's declaration. A concurrent create loses the race on
       * `@@unique([partId, regulation])` and is retried as the update it should have been,
       * rather than surfacing as a duplicate error on a screen where the caller did nothing
       * wrong.
       */
      const updated = await tx.partCompliance.updateMany({ where: { partId, regulation }, data });
      if (updated.count === 0) {
        try {
          await tx.partCompliance.create({ data: { partId, regulation, ...data } });
        } catch (err) {
          if ((err as { code?: string } | null)?.code !== 'P2002') throw err;
          await tx.partCompliance.updateMany({ where: { partId, regulation }, data });
        }
      }

      if (recipients.length > 0) {
        const row = await tx.part.findFirst({
          where: { id: partId },
          select: { partNumber: true },
        });
        // Inside the transaction, so a stored declaration whose notification was lost is not
        // a state this can reach.
        await notifyUsers(tx, recipients, actorId, {
          type: 'part.compliance',
          title: `${row?.partNumber ?? `Part ${partId}`} declared NON_COMPLIANT for ${regulation}`,
          body: notes,
          link: `/parts/${partId}`,
        });
      }
      return null;
    });
    void part;

    res.json(await partComplianceView(partId, user));
  })
);

// ---------------------------------------------------------------------------
// Declared substances on a part
// ---------------------------------------------------------------------------

router.post(
  '/parts/:id/substances',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const user = aclUser(req);
    await assertCanWrite('PART', partId, user);

    const body = bodyOf(req);
    const substanceId = idParam(String(body.substanceId ?? ''), 'substanceId');
    const substance = await getSubstanceOrThrow(substanceId);

    try {
      await prisma.partSubstance.create({
        data: {
          partId,
          substanceId,
          ppm: optionalPpm(body.ppm, 'ppm'),
          exemptionCode: optionalText(body.exemptionCode, 'exemptionCode', 64),
          notes: optionalText(body.notes, 'notes'),
          declaredById: currentUserId(req),
        },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        // One row per part and substance. A second measurement is an edit to the first, not a
        // second presence — two rows would double the substance in any report that sums them.
        throw new HttpError(409, `${substance.name} is already declared on this part`);
      }
      throw err;
    }
    res.status(201).json(await partComplianceView(partId, user));
  })
);

router.delete(
  '/part-substances/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    // As visible as the part it describes, and write-gated on that part (rules X2–X3).
    const existing = await prisma.partSubstance.findFirst({
      where: { id, part: partAcl(user) },
      select: { id: true, partId: true },
    });
    if (!existing) throw new HttpError(404, 'Part substance not found');
    await assertCanWrite('PART', existing.partId, user);
    await prisma.partSubstance.delete({ where: { id } });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// GET /parts/:id/compliance-rollup — the feature
// ---------------------------------------------------------------------------

/** One part as the walk found it. */
interface WalkNode {
  part: PartRefDto;
  /** True when this caller may not read it: counted, never named, never descended into. */
  hidden: boolean;
  /** Child part ids, in find-number order. Empty for a leaf AND for an unexpanded node. */
  children: number[];
}

interface Walk {
  nodes: Map<number, WalkNode>;
  /** Set when the depth cap, a cycle or a redacted node stopped the walk short of the end. */
  truncated: boolean;
  notes: string[];
}

/**
 * Walk the structure DOWNWARD from one revision, breadth-first, one query per level.
 *
 * Breadth-first and batched rather than the recursive shape routes/cost.ts uses, because this
 * walk is followed by six independent roll-ups over the same structure: collecting the graph
 * once means the regulations are answered in memory instead of re-reading the BOM six times.
 *
 * A part already expanded is not expanded again. That is not just deduplication — it is what
 * bounds the walk if the stored BOM contains a cycle, which the write paths prevent but a
 * restore or a direct database write can still produce. Same discipline as lib/whereUsed.ts.
 */
async function walkStructure(
  rootPart: { id: number; partNumber: string; name: string },
  rootRevisionId: number | null,
  user: AclUser
): Promise<Walk> {
  const nodes = new Map<number, WalkNode>();
  const notes: string[] = [];
  let truncated = false;
  let redactedSubtrees = 0;

  nodes.set(rootPart.id, { part: toPartRef(rootPart), hidden: false, children: [] });
  if (rootRevisionId === null) return { nodes, truncated, notes };

  const expanded = new Set<number>([rootPart.id]);
  let frontier: { partId: number; revisionId: number }[] = [
    { partId: rootPart.id, revisionId: rootRevisionId },
  ];

  for (let depth = 1; frontier.length > 0; depth += 1) {
    if (depth > MAX_TREE_DEPTH) {
      /*
       * Said out loud, and `truncated` set.
       *
       * An unexpanded node keeps an empty `children` list, which makes it a LEAF to the
       * roll-up below and therefore an UNKNOWN contributor unless a declaration above it
       * covers it. That is the fail-closed direction: a structure this product could not
       * finish reading cannot come out COMPLIANT because of where the walk stopped.
       */
      notes.push(
        `Structure deeper than ${MAX_TREE_DEPTH} levels was not expanded. Parts below that ` +
          'level count as UNKNOWN; this roll-up is not a complete reading of the assembly.'
      );
      truncated = true;
      break;
    }

    const lines = await prisma.bomLine.findMany({
      where: { parentRevisionId: { in: frontier.map((step) => step.revisionId) } },
      orderBy: [{ parentRevisionId: 'asc' }, { findNumber: 'asc' }],
      select: {
        parentRevisionId: true,
        childPartId: true,
        // The pin, so a released parent is walked with the children it was released with
        // rather than with whatever its children resolve to today.
        childRevisionId: true,
        childPart: {
          select: {
            id: true,
            partNumber: true,
            name: true,
            revisions: { select: { id: true, lifecycle: true } },
          },
        },
      },
    });
    if (lines.length === 0) break;

    const parentOf = new Map(frontier.map((step) => [step.revisionId, step.partId]));
    const visible = await visibleIds(
      'PART',
      lines.map((line) => line.childPartId),
      user
    );

    const next: { partId: number; revisionId: number }[] = [];
    for (const line of lines) {
      const parentPartId = parentOf.get(line.parentRevisionId);
      if (parentPartId === undefined) continue;
      const parent = nodes.get(parentPartId);
      if (parent && !parent.children.includes(line.childPartId)) {
        parent.children.push(line.childPartId);
      }

      const hidden = !visible.has(line.childPartId);
      if (!nodes.has(line.childPartId)) {
        nodes.set(line.childPartId, {
          // Rule X4 — the row stays and the identity goes. The count is what tells the caller
          // something is there; `REDACTED` is what stops it saying what.
          part: hidden
            ? { id: line.childPartId, partNumber: REDACTED.partNumber, name: REDACTED.name }
            : toPartRef(line.childPart),
          hidden,
          children: [],
        });
      }
      if (hidden) {
        /*
         * Not descended into. Its structure is its own data, withheld with its identity —
         * exactly as routes/cost.ts withholds a hidden child's unit cost. What is NOT
         * withheld is that it is there: it is counted, and the roll-up below treats it as an
         * UNKNOWN contributor that no ancestor declaration can cover.
         */
        redactedSubtrees += 1;
        continue;
      }
      if (expanded.has(line.childPartId)) continue;
      expanded.add(line.childPartId);
      /*
       * Where the parent pinned the line, the pin wins outright — including over a newer
       * released revision of the child, and including when the pinned revision has since been
       * made OBSOLETE. That is the entire purpose: a released assembly contains what it
       * contained, and a later revision of a child is a different assembly rather than a
       * correction to this one. A pin naming a revision that is not in the loaded list
       * resolves to null rather than falling back to the latest, because walking a revision
       * other than the one released is the defect the pin exists to prevent — and here it
       * would mean answering about an assembly nobody shipped.
       */
      const resolved = resolveDisplayRevision(line.childPart.revisions, line.childRevisionId);
      if (resolved) next.push({ partId: line.childPartId, revisionId: resolved.id });
    }
    frontier = next;
  }

  if (redactedSubtrees > 0) {
    truncated = true;
    notes.push(
      `${redactedSubtrees} part${redactedSubtrees === 1 ? '' : 's'} in this structure ` +
        `${redactedSubtrees === 1 ? 'is' : 'are'} restricted. Each counts as one UNKNOWN ` +
        'contributor and anything beneath it was not read, so this roll-up cannot be read as ' +
        'a complete account of the assembly.'
    );
  }
  return { nodes, truncated, notes };
}

/** A contributor to one regulation's answer: a declaration, or the absence of one. */
interface Contributor {
  partId: number;
  status: ComplianceStatus;
  declaredAt: Date | null;
  expiresAt: Date | null;
  /** True for a part this caller may not read: counted, never named. */
  hidden: boolean;
  /** True when a row exists. False means nobody has told us, which is not the same thing. */
  declared: boolean;
}

/**
 * Who answers for a regulation, and who is answered FOR.
 *
 * Three rules, and the middle one is the only part of this file that is a judgement rather
 * than a transcription of the spec:
 *
 *  1. **A part with its own declaration always contributes it.** A declaration is somebody's
 *     statement about that part, and it is the authority for it.
 *  2. **A declaration covers what is inside the part it is about — except at the root.** A
 *     purchased module declared RoHS compliant answers for its own internals: asking its
 *     undeclared children again would make every bought-in assembly UNKNOWN for ever, and a
 *     screen that is always UNKNOWN is a screen nobody reads — which is how the rule at the
 *     top of this file gets quietly switched off in practice. So an undeclared LEAF
 *     contributes UNKNOWN only when nothing above it has declared for that regulation.
 *     THE ROOT IS EXCLUDED because its declaration is the claim being checked rather than
 *     evidence for it; see `nextCovered` below for why that distinction is the whole value of
 *     this endpoint.
 *  3. **Coverage cannot erase a declaration beneath it.** The walk continues through a
 *     declared part, so a child declared NON_COMPLIANT under a parent declared COMPLIANT is
 *     still a contributor and still wins. A covering declaration answers for what nobody has
 *     said anything about; it cannot un-say something that was said.
 *
 * An undeclared ASSEMBLY never contributes itself — its children answer — which is the same
 * shape rule T8 gives the cost roll-up, where a part with no `unitCost` takes the sum of its
 * children and only a childless one joins `missingCosts`.
 *
 * A HIDDEN part is always a contributor and is never covered. If an ancestor's COMPLIANT
 * declaration could cover it, an assembly whose unreadable child is the non-compliant one
 * would read clean — the one outcome this endpoint exists to prevent.
 *
 * Reached states are memoised on (part, covered), so a part reachable by two routes is visited
 * at most twice and the UNCOVERED visit is the one that adds a contributor: where any route
 * reaches a part with nothing answering for it, nothing answers for it.
 */
function contributorsFor(
  walk: Walk,
  rootPartId: number,
  declarations: Map<number, Map<Regulation, ComplianceRow>>,
  regulation: Regulation
): { contributors: Map<number, Contributor>; cycleStopped: boolean } {
  const contributors = new Map<number, Contributor>();
  const seen = new Set<string>();
  let cycleStopped = false;

  const visit = (
    partId: number,
    covered: boolean,
    path: Set<number>,
    isRoot: boolean
  ): void => {
    const node = walk.nodes.get(partId);
    if (!node) return;
    const stateKey = `${partId}:${covered ? 1 : 0}`;
    if (seen.has(stateKey)) return;
    seen.add(stateKey);

    if (node.hidden) {
      contributors.set(partId, {
        partId,
        status: ComplianceStatus.UNKNOWN,
        declaredAt: null,
        expiresAt: null,
        hidden: true,
        declared: false,
      });
      return;
    }

    const declaration = declarations.get(partId)?.get(regulation);
    if (declaration) {
      contributors.set(partId, {
        partId,
        status: declaration.status,
        declaredAt: declaration.declaredAt,
        expiresAt: declaration.expiresAt,
        hidden: false,
        declared: true,
      });
    } else if (node.children.length === 0 && !covered) {
      contributors.set(partId, {
        partId,
        status: ComplianceStatus.UNKNOWN,
        declaredAt: null,
        expiresAt: null,
        hidden: false,
        declared: false,
      });
    }

    /*
     * THE ROOT'S OWN DECLARATION NEVER COVERS THE ROOT'S OWN SUBTREE.
     *
     * Rule 2 above is about somebody ELSE's statement: a supplier declaring a module they
     * built answers for that module's internals. The declaration on the part being asked
     * about is not that. It is the claim this endpoint was called to check, and letting it
     * cover its own descendants makes the answer circular — declare the top assembly
     * COMPLIANT and the roll-up confirms it, whatever is or is not known beneath it. That is
     * exactly the always-green screen the rule at the top of this file exists to refuse, and
     * it is reached by the single most ordinary route there is: record the conformity claim,
     * then open the roll-up to check it.
     *
     * So the root's declaration is still a contributor — it is a fact, and it is reported —
     * but coverage begins one level down.
     */
    const nextCovered = covered || (declaration !== undefined && !isRoot);
    const nextPath = new Set(path).add(partId);
    for (const childId of node.children) {
      // A child already on this path is a cycle. Stopping is correct and saying so is the
      // point: a roll-up that silently walked part of a loop is a truncated one.
      if (nextPath.has(childId)) {
        cycleStopped = true;
        continue;
      }
      visit(childId, nextCovered, nextPath, false);
    }
  };

  visit(rootPartId, false, new Set(), true);
  return { contributors, cycleStopped };
}

/**
 * The one rule that must not bend, in four lines.
 *
 * COMPLIANT requires every contributor to be COMPLIANT or EXEMPT. One UNKNOWN makes the whole
 * assembly UNKNOWN — not compliant, and not non-compliant. NON_COMPLIANT outranks UNKNOWN
 * because a known failure is more actionable than an absence, and the empty case is UNKNOWN
 * rather than COMPLIANT: an assembly nobody has said anything about is not compliant by
 * default, which is the vacuous-truth version of the same lie.
 */
function rollupStatus(counts: {
  compliant: number;
  nonCompliant: number;
  exempt: number;
  unknown: number;
}): ComplianceStatus {
  if (counts.nonCompliant > 0) return ComplianceStatus.NON_COMPLIANT;
  if (counts.unknown > 0) return ComplianceStatus.UNKNOWN;
  if (counts.compliant + counts.exempt > 0) return ComplianceStatus.COMPLIANT;
  return ComplianceStatus.UNKNOWN;
}

router.get(
  '/parts/:id/compliance-rollup',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const user = aclUser(req);
    // Before anything else: a restricted part answers 404, never 403 (rule X3).
    await assertCanRead('PART', partId, user);
    const part = await prisma.part.findUniqueOrThrow({
      where: { id: partId },
      select: {
        id: true,
        partNumber: true,
        name: true,
        category: true,
        revisions: { select: { id: true, revision: true, lifecycle: true } },
      },
    });

    /*
     * Resolved WITHOUT a pin, deliberately: this endpoint is addressed by PART, so there is no
     * BOM line in hand and no single answer to "which revision is this part pinned to" across
     * every assembly that uses it. Latest RELEASED, else latest — the rule the BOM tab shows.
     * Lines BELOW the root honour their pins (see the walk).
     */
    const rootRevision = resolveDisplayRevision(part.revisions);
    const walk = await walkStructure(part, rootRevision?.id ?? null, user);
    const notes = [...walk.notes];
    if (rootRevision === null) {
      notes.push('This part has no revisions, so no structure was walked.');
    }

    const visiblePartIds = [...walk.nodes.values()]
      .filter((node) => !node.hidden)
      .map((node) => node.part.id);
    const rows = await prisma.partCompliance.findMany({
      where: { partId: { in: visiblePartIds } },
      select: { ...complianceSelect, partId: true },
    });
    const declarations = new Map<number, Map<Regulation, ComplianceRow>>();
    for (const row of rows) {
      const forPart = declarations.get(row.partId) ?? new Map<Regulation, ComplianceRow>();
      forPart.set(row.regulation, row);
      declarations.set(row.partId, forPart);
    }

    const now = new Date();
    let truncated = walk.truncated;
    const regulations: RegulationRollupDto[] = REGULATIONS.map((regulation) => {
      const { contributors, cycleStopped } = contributorsFor(
        walk,
        part.id,
        declarations,
        regulation
      );
      if (cycleStopped) truncated = true;

      const counts = { compliant: 0, nonCompliant: 0, exempt: 0, unknown: 0, redacted: 0 };
      const nonCompliantParts: PartRefDto[] = [];
      const unknownParts: PartRefDto[] = [];
      const expired: ExpiredDeclarationDto[] = [];
      let oldest: Date | null = null;
      let undated = 0;

      for (const contributor of [...contributors.values()].sort((a, b) => a.partId - b.partId)) {
        const node = walk.nodes.get(contributor.partId);
        if (!node) continue;
        switch (contributor.status) {
          case ComplianceStatus.COMPLIANT:
            counts.compliant += 1;
            break;
          case ComplianceStatus.NON_COMPLIANT:
            counts.nonCompliant += 1;
            // Named, because this is the list somebody works from.
            if (!contributor.hidden) nonCompliantParts.push(node.part);
            break;
          case ComplianceStatus.EXEMPT:
            // EXEMPT counts as compliant: presence permitted by a named exemption is a legal
            // declaration, not a gap. Its expiry is reported below rather than reclassified.
            counts.exempt += 1;
            break;
          case ComplianceStatus.UNKNOWN:
            counts.unknown += 1;
            if (contributor.hidden) counts.redacted += 1;
            else unknownParts.push(node.part);
            break;
        }
        if (contributor.declared) {
          if (contributor.declaredAt === null) undated += 1;
          else if (oldest === null || contributor.declaredAt < oldest) {
            oldest = contributor.declaredAt;
          }
          /*
           * An expired declaration does NOT silently become NON_COMPLIANT. Flipping somebody
           * else's declaration is a second, quieter lie than rounding UNKNOWN up to green: it
           * invents a fact instead of hiding one. It is reported with its date and its status,
           * and a person decides. COMPLIANT declarations that have lapsed are carried in the
           * same list — the hazard is identical and `status` says which kind it is.
           */
          if (contributor.expiresAt !== null && contributor.expiresAt < now && !contributor.hidden) {
            expired.push({
              part: node.part,
              status: contributor.status,
              expiresAt: contributor.expiresAt.toISOString(),
            });
          }
        }
      }

      return {
        regulation,
        status: rollupStatus(counts),
        counts,
        nonCompliantParts,
        unknownParts,
        expired,
        oldestEvidenceAt: oldest === null ? null : oldest.toISOString(),
        undatedEvidenceCount: undated,
      };
    });

    /*
     * The one case worth interrupting somebody over: a conformity claim recorded on this part
     * that the structure beneath it does not support. The claim is kept and the disagreement
     * is named — this endpoint reports, it does not overwrite anybody's declaration.
     */
    const overclaimed = regulations.filter((entry) => {
      const own = declarations.get(part.id)?.get(entry.regulation);
      if (!own) return false;
      const claimed =
        own.status === ComplianceStatus.COMPLIANT || own.status === ComplianceStatus.EXEMPT;
      return claimed && entry.status !== ComplianceStatus.COMPLIANT;
    });
    if (overclaimed.length > 0) {
      notes.push(
        `This part carries its own declaration for ${overclaimed
          .map((entry) => entry.regulation)
          .join(', ')}, but the structure beneath it does not support it. A declaration on a ` +
          'part is not evidence about that part\u2019s children, so it is reported here and ' +
          'not used to answer for them.'
      );
    }

    if (regulations.some((entry) => entry.expired.length > 0)) {
      notes.push(
        'One or more declarations have passed their expiry date. They are reported as ' +
          'declared, not reclassified — review them before claiming conformity.'
      );
    }
    if (truncated && !notes.some((note) => note.includes('cycle'))) {
      // Only a cycle has not yet pushed a note of its own.
      const cycleOnly = !walk.truncated;
      if (cycleOnly) {
        notes.push(
          'A cycle in the stored structure stopped the walk. This roll-up is not a complete ' +
            'reading of the assembly.'
        );
      }
    }

    const payload: ComplianceRollupDto = {
      part: toPartRef(part),
      revision: rootRevision
        ? {
            id: rootRevision.id,
            revision: rootRevision.revision,
            lifecycle: rootRevision.lifecycle,
          }
        : null,
      partsExamined: walk.nodes.size,
      redactedCount: [...walk.nodes.values()].filter((node) => node.hidden).length,
      truncated,
      regulations,
      notes,
    };
    res.json(payload);
  })
);

export default router;
