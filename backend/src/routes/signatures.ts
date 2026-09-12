/**
 * Electronic signatures and controlled release — rules S1–S4.
 *
 * Signatures are append-only: the only mutation after creation is voiding, which happens
 * automatically when the signed content changes. Nothing here exposes an update or delete.
 */
import { Request, Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  Prisma,
  Role,
  SignatureAuthMethod,
  SignatureMeaning,
  SignatureStatus,
  SignedEntityType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { contentHashFor, entityLabel } from '../lib/signing';
import { AclUser, aclFilter, assertCanRead } from '../lib/acl';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

interface SignatureRequirementDto {
  id: number;
  entityType: SignedEntityType;
  meaning: SignatureMeaning;
  seq: number;
  role: Role | null;
  user: UserRefDto | null;
  active: boolean;
}

interface ElectronicSignatureDto {
  id: number;
  meaning: SignatureMeaning;
  user: UserRefDto;
  signedName: string;
  signedRole: string;
  signedAt: string;
  authMethod: SignatureAuthMethod;
  status: SignatureStatus;
  voidedAt: string | null;
  voidedReason: string | null;
  comment: string | null;
}

interface ManifestEntryDto {
  requirement: SignatureRequirementDto;
  signature: ElectronicSignatureDto | null;
  /** Whether the acting user may execute this requirement right now. */
  canSign: boolean;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ENTITY_TYPES = new Set<string>(Object.values(SignedEntityType));
const MEANINGS = new Set<string>(Object.values(SignatureMeaning));

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

/** `/ecns/:id/signatures` style path segment → enum. */
function parseEntityType(value: string): SignedEntityType {
  const upper = value.toUpperCase();
  if (!ENTITY_TYPES.has(upper)) throw new HttpError(400, `Unknown signed entity type: ${value}`);
  return upper as SignedEntityType;
}

function parseMeaning(value: unknown): SignatureMeaning {
  if (typeof value !== 'string' || !MEANINGS.has(value)) {
    throw new HttpError(400, `meaning must be one of ${[...MEANINGS].join(', ')}`);
  }
  return value as SignatureMeaning;
}

function toRequirementDto(row: {
  id: number;
  entityType: SignedEntityType;
  meaning: SignatureMeaning;
  seq: number;
  role: Role | null;
  active: boolean;
  user: { id: number; name: string } | null;
}): SignatureRequirementDto {
  return {
    id: row.id,
    entityType: row.entityType,
    meaning: row.meaning,
    seq: row.seq,
    role: row.role,
    user: row.user ? { id: row.user.id, name: row.user.name } : null,
    active: row.active,
  };
}

function toSignatureDto(row: {
  id: number;
  meaning: SignatureMeaning;
  signedName: string;
  signedRole: string;
  signedAt: Date;
  authMethod: SignatureAuthMethod;
  status: SignatureStatus;
  voidedAt: Date | null;
  voidedReason: string | null;
  comment: string | null;
  user: { id: number; name: string };
}): ElectronicSignatureDto {
  return {
    id: row.id,
    meaning: row.meaning,
    user: { id: row.user.id, name: row.user.name },
    signedName: row.signedName,
    signedRole: row.signedRole,
    signedAt: row.signedAt.toISOString(),
    authMethod: row.authMethod,
    status: row.status,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidedReason: row.voidedReason,
    comment: row.comment,
  };
}

const signatureSelect = {
  id: true,
  meaning: true,
  signedName: true,
  signedRole: true,
  signedAt: true,
  authMethod: true,
  status: true,
  voidedAt: true,
  voidedReason: true,
  comment: true,
  contentHash: true,
  userId: true,
  user: { select: { id: true, name: true } },
} satisfies Prisma.ElectronicSignatureSelect;

const requirementSelect = {
  id: true,
  entityType: true,
  meaning: true,
  seq: true,
  role: true,
  active: true,
  user: { select: { id: true, name: true } },
} satisfies Prisma.SignatureRequirementSelect;

// ---------------------------------------------------------------------------
// Shared manifest logic (rule S3) — also used by the release gates
// ---------------------------------------------------------------------------

export interface Manifest {
  contentHash: string;
  entries: ManifestEntryDto[];
  complete: boolean;
  /** Meanings still needing a valid signature — the 409 text on a blocked release. */
  outstanding: SignatureMeaning[];
  /**
   * Every signature ever executed against this entity, newest first — including voided
   * ones. A voided signature is part of the audit trail: hiding it would lose the fact
   * that somebody signed and the content then changed under them.
   */
  history: ElectronicSignatureDto[];
}

/**
 * Build the manifest, voiding any signature whose content has since changed.
 *
 * Voiding on read rather than only on write is deliberate: content can change through
 * paths that never think about signatures (a BOM edit, an ECN item swap), and a stale
 * signature must never be able to satisfy a gate.
 */
export async function buildManifest(
  entityType: SignedEntityType,
  entityId: number,
  actingUser: { id: number; role: Role } | null
): Promise<Manifest> {
  const contentHash = await contentHashFor(entityType, entityId);

  const [requirements, signatures] = await Promise.all([
    prisma.signatureRequirement.findMany({
      where: { entityType, active: true },
      orderBy: [{ seq: 'asc' }, { id: 'asc' }],
      select: requirementSelect,
    }),
    prisma.electronicSignature.findMany({
      where: { entityType, entityId },
      orderBy: { signedAt: 'asc' },
      select: signatureSelect,
    }),
  ]);

  const stale = signatures.filter(
    (signature) => signature.status === SignatureStatus.VALID && signature.contentHash !== contentHash
  );
  if (stale.length > 0) {
    const label = await entityLabel(entityType, entityId);
    await prisma.electronicSignature.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: {
        status: SignatureStatus.VOIDED,
        voidedAt: new Date(),
        voidedReason: `${label} changed after signing`,
      },
    });
    for (const signature of stale) {
      signature.status = SignatureStatus.VOIDED;
      signature.voidedReason = `${label} changed after signing`;
      signature.voidedAt = new Date();
    }
  }

  const entries: ManifestEntryDto[] = requirements.map((requirement) => {
    const match = signatures.find(
      (signature) =>
        signature.meaning === requirement.meaning &&
        signature.status === SignatureStatus.VALID &&
        (requirement.user === null || signature.userId === requirement.user.id)
    );
    return {
      requirement: toRequirementDto(requirement),
      signature: match ? toSignatureDto(match) : null,
      canSign:
        match === undefined &&
        actingUser !== null &&
        actingUser.role !== Role.VIEWER &&
        satisfies(requirement, actingUser),
    };
  });

  const outstanding = entries
    .filter((entry) => entry.signature === null)
    .map((entry) => entry.requirement.meaning);

  return {
    contentHash,
    entries,
    complete: outstanding.length === 0,
    outstanding,
    history: [...signatures].reverse().map(toSignatureDto),
  };
}

/** Does this user satisfy the requirement — by name, or by holding the role? */
function satisfies(
  requirement: { role: Role | null; user: { id: number } | null },
  user: { id: number; role: Role }
): boolean {
  // A named signer wins over a role: the requirement names that person specifically.
  if (requirement.user !== null) return requirement.user.id === user.id;
  if (requirement.role !== null) return requirement.role === user.role;
  return false;
}

/**
 * Release gate (rule S4). Throws 409 when signatures are outstanding.
 * With no active requirements the manifest is complete, so nothing is gated.
 */
export async function assertSignaturesComplete(
  entityType: SignedEntityType,
  entityId: number,
  action: string
): Promise<void> {
  const manifest = await buildManifest(entityType, entityId, null);
  if (!manifest.complete) {
    throw new HttpError(
      409,
      `Cannot ${action}: signatures outstanding for: ${manifest.outstanding.join(', ')}`
    );
  }
}

// ---------------------------------------------------------------------------
// GET /:entityType/:id/signatures — the manifest
// ---------------------------------------------------------------------------

const ENTITY_PATHS: Record<string, SignedEntityType> = {
  ecns: SignedEntityType.ECN,
  revisions: SignedEntityType.REVISION,
  documents: SignedEntityType.DOCUMENT,
};

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

/**
 * Rule X3 — a signature manifest names the thing it signs, so reading one is reading that
 * item. Without this gate the manifest's `label` handed out the ECN number, part number or
 * document number of an item the caller is otherwise 404'd from, and `canSign` invited them
 * to sign it.
 *
 * A REVISION carries no grants of its own; it is exactly as visible as its part, resolved
 * through the part's read filter so a restricted part's revision fails identically to a
 * revision id that does not exist.
 */
async function assertCanReadSigned(
  entityType: SignedEntityType,
  entityId: number,
  user: AclUser
): Promise<void> {
  if (entityType === SignedEntityType.REVISION) {
    const revision = await prisma.partRevision.findFirst({
      where: { id: entityId, part: aclFilter('PART', user) as Prisma.PartWhereInput },
      select: { id: true },
    });
    if (!revision) throw new HttpError(404, 'Revision not found');
    return;
  }
  await assertCanRead(entityType === SignedEntityType.ECN ? 'ECN' : 'DOCUMENT', entityId, user);
}

router.get(
  '/:entityPath(ecns|revisions|documents)/:id/signatures',
  asyncHandler(async (req, res) => {
    const entityType = ENTITY_PATHS[req.params.entityPath];
    const entityId = idParam(req.params.id);
    if (!req.user) throw new HttpError(401, 'Not authenticated');
    await assertCanReadSigned(entityType, entityId, aclUser(req));
    const manifest = await buildManifest(entityType, entityId, {
      id: req.user.id,
      role: req.user.role as Role,
    });
    res.json({
      entityType,
      entityId,
      label: await entityLabel(entityType, entityId),
      ...manifest,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /:entityType/:id/signatures — execute a signature (rule S2)
// ---------------------------------------------------------------------------

router.post(
  '/:entityPath(ecns|revisions|documents)/:id/signatures',
  asyncHandler(async (req, res) => {
    const entityType = ENTITY_PATHS[req.params.entityPath];
    const entityId = idParam(req.params.id);
    const userId = currentUserId(req);
    // Rule X3 — before the body is parsed, and before any 403 about roles: signing an item
    // one cannot read is both a disclosure and a forged approval.
    await assertCanReadSigned(entityType, entityId, aclUser(req));
    const body = bodyOf(req);
    const meaning = parseMeaning(body.meaning);
    const comment =
      body.comment === undefined || body.comment === null
        ? null
        : String(body.comment).trim().slice(0, 1000) || null;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, passwordHash: true },
    });
    if (!user) throw new HttpError(401, 'Not authenticated');
    if (user.role === Role.VIEWER) {
      throw new HttpError(403, 'Read-only accounts cannot sign');
    }

    // Rule S2 — re-authentication is mandatory. An account with a password re-enters it;
    // a Google-only account has none, so it retypes its own address instead. Which method
    // was used is recorded, so the strength of every signature stays auditable.
    let authMethod: SignatureAuthMethod;
    if (user.passwordHash) {
      const password = body.password;
      if (typeof password !== 'string' || password === '') {
        throw new HttpError(400, 'Re-enter your password to sign');
      }
      if (!(await bcrypt.compare(password, user.passwordHash))) {
        throw new HttpError(401, 'Password is incorrect');
      }
      authMethod = SignatureAuthMethod.PASSWORD;
    } else {
      const confirmEmail = body.confirmEmail;
      if (typeof confirmEmail !== 'string' || confirmEmail.trim() === '') {
        throw new HttpError(400, 'Retype your email address to sign');
      }
      if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
        throw new HttpError(401, 'That is not your email address');
      }
      authMethod = SignatureAuthMethod.EMAIL_CONFIRM;
    }

    const manifest = await buildManifest(entityType, entityId, {
      id: user.id,
      role: user.role,
    });

    const already = manifest.entries.find(
      (entry) => entry.requirement.meaning === meaning && entry.signature?.user.id === user.id
    );
    if (already) {
      throw new HttpError(409, `You have already signed this as ${meaning}`);
    }

    const permitted = manifest.entries.filter(
      (entry) => entry.requirement.meaning === meaning && entry.canSign
    );
    if (permitted.length === 0) {
      const forMeaning = manifest.entries.filter(
        (entry) => entry.requirement.meaning === meaning
      );
      if (forMeaning.length === 0) {
        throw new HttpError(409, `${meaning} is not a required signature for this ${entityType}`);
      }
      const who = forMeaning
        .map((entry) => entry.requirement.user?.name ?? entry.requirement.role ?? 'nobody')
        .join(' or ');
      throw new HttpError(409, `${meaning} must be signed by ${who}`);
    }

    await prisma.electronicSignature.create({
      data: {
        entityType,
        entityId,
        meaning,
        userId: user.id,
        // Captured standalone: Part 11 §11.50 needs the record readable on its own, and a
        // user can be renamed or re-roled after signing.
        signedName: user.name,
        signedRole: user.role,
        authMethod,
        contentHash: manifest.contentHash,
        comment,
      },
    });

    const refreshed = await buildManifest(entityType, entityId, {
      id: user.id,
      role: user.role,
    });
    res.status(201).json({
      entityType,
      entityId,
      label: await entityLabel(entityType, entityId),
      ...refreshed,
    });
  })
);

// ---------------------------------------------------------------------------
// Requirement administration (rule S1) — ADMIN only
// ---------------------------------------------------------------------------

router.get(
  '/signature-requirements',
  asyncHandler(async (req, res) => {
    const entityTypeRaw = req.query.entityType;
    const where =
      typeof entityTypeRaw === 'string' && entityTypeRaw !== ''
        ? { entityType: parseEntityType(entityTypeRaw) }
        : {};
    const rows = await prisma.signatureRequirement.findMany({
      where,
      orderBy: [{ entityType: 'asc' }, { seq: 'asc' }, { id: 'asc' }],
      select: requirementSelect,
    });
    res.json(rows.map(toRequirementDto));
  })
);

/** Exactly one of role / userId identifies who may sign. */
function parseSigner(body: Record<string, unknown>): { role: Role | null; userId: number | null } {
  const hasRole = body.role !== undefined && body.role !== null;
  const hasUser = body.userId !== undefined && body.userId !== null;
  if (hasRole === hasUser) {
    throw new HttpError(400, 'Give exactly one of role or userId');
  }
  if (hasRole) {
    const role = body.role;
    if (typeof role !== 'string' || !Object.values(Role).includes(role as Role)) {
      throw new HttpError(400, `role must be one of ${Object.values(Role).join(', ')}`);
    }
    if (role === Role.VIEWER) throw new HttpError(400, 'A read-only role cannot be a signer');
    return { role: role as Role, userId: null };
  }
  const userId = body.userId;
  if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0) {
    throw new HttpError(400, 'userId must be a positive integer');
  }
  return { role: null, userId };
}

router.post(
  '/signature-requirements',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const body = bodyOf(req);
    const entityType = parseEntityType(
      typeof body.entityType === 'string' ? body.entityType : ''
    );
    const meaning = parseMeaning(body.meaning);
    const { role, userId } = parseSigner(body);
    const seq =
      body.seq === undefined || body.seq === null
        ? 1
        : typeof body.seq === 'number' && Number.isInteger(body.seq) && body.seq > 0
          ? body.seq
          : (() => {
              throw new HttpError(400, 'seq must be a positive integer');
            })();

    if (userId !== null) {
      const signer = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (!signer) throw new HttpError(400, 'Signer not found');
      if (signer.role === Role.VIEWER) {
        throw new HttpError(400, 'A read-only account cannot be a signer');
      }
    }

    try {
      const created = await prisma.signatureRequirement.create({
        data: { entityType, meaning, seq, role, userId },
        select: requirementSelect,
      });
      res.status(201).json(toRequirementDto(created));
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new HttpError(409, `A ${meaning} requirement already exists at step ${seq}`);
      }
      throw err;
    }
  })
);

router.patch(
  '/signature-requirements/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);
    const body = bodyOf(req);
    const existing = await prisma.signatureRequirement.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'Signature requirement not found');

    const data: Prisma.SignatureRequirementUncheckedUpdateInput = {};
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new HttpError(400, 'active must be a boolean');
      data.active = body.active;
    }
    if (body.seq !== undefined) {
      if (typeof body.seq !== 'number' || !Number.isInteger(body.seq) || body.seq <= 0) {
        throw new HttpError(400, 'seq must be a positive integer');
      }
      data.seq = body.seq;
    }
    if (body.role !== undefined || body.userId !== undefined) {
      const signer = parseSigner(body);
      data.role = signer.role;
      data.userId = signer.userId;
    }

    const updated = await prisma.signatureRequirement.update({
      where: { id },
      data,
      select: requirementSelect,
    });
    res.json(toRequirementDto(updated));
  })
);

router.delete(
  '/signature-requirements/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);
    const existing = await prisma.signatureRequirement.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'Signature requirement not found');
    // Requirements are configuration, not records — deleting one is fine. The signatures
    // already executed against it are untouched.
    await prisma.signatureRequirement.delete({ where: { id } });
    res.status(204).send();
  })
);

export default router;
