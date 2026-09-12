import { Request, Router } from 'express';
import { AmlStatus, Manufacturer, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { AclUser, aclFilter, assertCanWrite } from '../lib/acl';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface ManufacturerSummaryDto {
  id: number;
  name: string;
  website: string | null;
}

interface ManufacturerPartDetailDto {
  id: number;
  manufacturer: ManufacturerSummaryDto;
  mpn: string;
  status: AmlStatus;
  description: string | null;
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

const manufacturerPartInclude = { manufacturer: true } satisfies Prisma.ManufacturerPartInclude;

type ManufacturerPartRow = Prisma.ManufacturerPartGetPayload<{
  include: typeof manufacturerPartInclude;
}>;

function toManufacturer(manufacturer: Manufacturer): ManufacturerSummaryDto {
  return { id: manufacturer.id, name: manufacturer.name, website: manufacturer.website };
}

function toManufacturerPart(row: ManufacturerPartRow): ManufacturerPartDetailDto {
  return {
    id: row.id,
    manufacturer: toManufacturer(row.manufacturer),
    mpn: row.mpn,
    status: row.status,
    description: row.description,
  };
}

/** Rule T3 — PREFERRED first, then the remaining statuses, then mpn (sorted in JS). */
const AML_STATUS_ORDER: Record<AmlStatus, number> = {
  [AmlStatus.PREFERRED]: 0,
  [AmlStatus.APPROVED]: 1,
  [AmlStatus.ALTERNATE]: 2,
  [AmlStatus.OBSOLETE]: 3,
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function optionalNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function positiveInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return n;
}

function parseMpn(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'mpn is required');
  }
  const trimmed = value.trim();
  if (trimmed.length > 80) throw new HttpError(400, 'mpn must be at most 80 characters');
  return trimmed;
}

function parseAmlStatus(value: unknown): AmlStatus {
  if (typeof value !== 'string' || !(Object.values(AmlStatus) as string[]).includes(value)) {
    throw new HttpError(400, 'status must be one of PREFERRED, APPROVED, ALTERNATE, OBSOLETE');
  }
  return value as AmlStatus;
}

// ---------------------------------------------------------------------------
// GET /manufacturers — search by name, ordered by name, max 50
// ---------------------------------------------------------------------------

router.get(
  '/manufacturers',
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const where: Prisma.ManufacturerWhereInput = search
      ? { name: { contains: search, mode: 'insensitive' } }
      : {};
    const manufacturers = await prisma.manufacturer.findMany({
      where,
      orderBy: { name: 'asc' },
      take: 50,
    });
    res.json(manufacturers.map(toManufacturer));
  })
);

// ---------------------------------------------------------------------------
// POST /manufacturers — create (name unique)
// ---------------------------------------------------------------------------

router.post(
  '/manufacturers',
  asyncHandler(async (req, res) => {
    const body = requireBody(req);
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw new HttpError(400, 'name is required');
    }
    const name = body.name.trim();
    const website = body.website === undefined ? null : optionalNullableText(body.website, 'website');

    const existing = await prisma.manufacturer.findUnique({ where: { name }, select: { id: true } });
    if (existing) throw new HttpError(409, `Manufacturer "${name}" already exists`);

    const created = await prisma.manufacturer.create({ data: { name, website } });
    res.status(201).json(toManufacturer(created));
  })
);


function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

function partAcl(user: AclUser): Prisma.PartWhereInput {
  return aclFilter('PART', user) as Prisma.PartWhereInput;
}

// ---------------------------------------------------------------------------
// GET /parts/:id/manufacturer-parts — AML for a part (rule T3 ordering)
// ---------------------------------------------------------------------------

router.get(
  '/parts/:id/manufacturer-parts',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    // A restricted part 404s like a missing one (rule X2).
    const part = await prisma.part.findFirst({
      where: { id: partId, ...partAcl(aclUser(req)) },
      select: { id: true },
    });
    if (!part) throw new HttpError(404, 'Part not found');

    const rows = await prisma.manufacturerPart.findMany({
      where: { partId },
      include: manufacturerPartInclude,
    });
    rows.sort(
      (a, b) => AML_STATUS_ORDER[a.status] - AML_STATUS_ORDER[b.status] || a.mpn.localeCompare(b.mpn)
    );
    res.json(rows.map(toManufacturerPart));
  })
);

// ---------------------------------------------------------------------------
// POST /parts/:id/manufacturer-parts — add an AML entry (rule T3)
// ---------------------------------------------------------------------------

router.post(
  '/parts/:id/manufacturer-parts',
  asyncHandler(async (req, res) => {
    const partId = idParam(req.params.id);
    const body = requireBody(req);

    const manufacturerId = positiveInt(body.manufacturerId, 'manufacturerId');
    const mpn = parseMpn(body.mpn);
    const status = body.status === undefined ? AmlStatus.APPROVED : parseAmlStatus(body.status);
    const description =
      body.description === undefined ? null : optionalNullableText(body.description, 'description');

    const user = aclUser(req);
    const part = await prisma.part.findFirst({
      where: { id: partId, ...partAcl(user) },
      select: { id: true },
    });
    if (!part) throw new HttpError(404, 'Part not found');
    // The AML is the part's sourcing definition — a write to the part.
    await assertCanWrite('PART', partId, user);
    const manufacturer = await prisma.manufacturer.findUnique({
      where: { id: manufacturerId },
      select: { id: true },
    });
    if (!manufacturer) throw new HttpError(404, 'Manufacturer not found');

    const duplicate = await prisma.manufacturerPart.findUnique({
      where: { partId_manufacturerId_mpn: { partId, manufacturerId, mpn } },
      select: { id: true },
    });
    if (duplicate) {
      throw new HttpError(409, 'This manufacturer part is already listed for the part');
    }

    const created = await prisma.manufacturerPart.create({
      data: { partId, manufacturerId, mpn, status, description },
      include: manufacturerPartInclude,
    });
    res.status(201).json(toManufacturerPart(created));
  })
);

// ---------------------------------------------------------------------------
// PATCH /manufacturer-parts/:id
// ---------------------------------------------------------------------------

router.patch(
  '/manufacturer-parts/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = requireBody(req);

    const user = aclUser(req);
    const existing = await prisma.manufacturerPart.findFirst({
      where: { id, part: partAcl(user) },
    });
    if (!existing) throw new HttpError(404, 'Manufacturer part not found');
    await assertCanWrite('PART', existing.partId, user);

    const data: Prisma.ManufacturerPartUpdateInput = {};
    let newMpn: string | undefined;
    if (body.mpn !== undefined) {
      newMpn = parseMpn(body.mpn);
      data.mpn = newMpn;
    }
    if (body.status !== undefined) data.status = parseAmlStatus(body.status);
    if (body.description !== undefined) {
      data.description = optionalNullableText(body.description, 'description');
    }

    if (newMpn !== undefined && newMpn !== existing.mpn) {
      const duplicate = await prisma.manufacturerPart.findFirst({
        where: {
          partId: existing.partId,
          manufacturerId: existing.manufacturerId,
          mpn: newMpn,
          id: { not: id },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new HttpError(409, 'This manufacturer part is already listed for the part');
      }
    }

    const updated = await prisma.manufacturerPart.update({
      where: { id },
      data,
      include: manufacturerPartInclude,
    });
    res.json(toManufacturerPart(updated));
  })
);

// ---------------------------------------------------------------------------
// DELETE /manufacturer-parts/:id
// ---------------------------------------------------------------------------

router.delete(
  '/manufacturer-parts/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const user = aclUser(req);
    const existing = await prisma.manufacturerPart.findFirst({
      where: { id, part: partAcl(user) },
      select: { id: true, partId: true },
    });
    if (!existing) throw new HttpError(404, 'Manufacturer part not found');
    await assertCanWrite('PART', existing.partId, user);
    await prisma.manufacturerPart.delete({ where: { id } });
    res.status(204).end();
  })
);

export default router;
