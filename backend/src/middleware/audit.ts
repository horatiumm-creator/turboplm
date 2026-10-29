import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Automatic audit trail: every successful (2xx) mutating /api call is logged with
 * the acting user, method, path, a derived entity reference, and the sanitized
 * request body. Mounted after requireAuth so req.user is set.
 */

/**
 * Body fields whose VALUE must never reach the audit trail.
 *
 * Matched on a normalised name — lower-cased with `_` and `-` removed — and as a SUBSTRING,
 * because the previous version was an exact, case-sensitive, top-level-only set of four
 * literal names and that is not a property anybody can maintain. `clientSecret` did not match
 * `secret`; `apiKey` matched nothing at all. The first endpoint to accept a credential under
 * a name nobody had thought of would have written it, in plaintext, into the one table this
 * product promises never to lose — and `GET /audit` hands `details` straight back to any
 * authenticated caller.
 *
 * Over-redaction is the safe direction here. A field called `tokenCount` losing its value in
 * the audit log costs a reader one lookup; a field called `openai_key` keeping its value costs
 * a user their credential.
 */
const SENSITIVE_SUBSTRING =
  /(password|passwd|secret|token|credential|authorization|accesskey|privatekey)/;

/*
 * ...and anything whose name ENDS in "key", which is the half a substring list keeps missing.
 * `openai_key` normalises to `openaikey`: it contains neither `apikey` nor `accesskey`, so a
 * list of known credential words let it straight through. The next provider will be called
 * something else too.
 *
 * It over-matches a hypothetical `sortKey` or `partKey`, neither of which exists in any body
 * this product accepts, and losing such a value in the trail costs a reader one lookup.
 */
function isSensitiveName(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_SUBSTRING.test(normalised) || normalised.endsWith('key');
}

/** Nested bodies are walked, but not forever: a cycle or a pathological nest must not hang. */
const MAX_SANITIZE_DEPTH = 6;

/** Path prefix → audit entity type. Longest match wins. */
const ENTITY_PATTERNS: [RegExp, string][] = [
  [/^\/parts\/(\d+)\/revisions/, 'PART'],
  [/^\/parts\/(\d+)\/manufacturer-parts/, 'PART'],
  [/^\/parts\/(\d+)\/attributes/, 'PART'],
  [/^\/parts\/(\d+)/, 'PART'],
  [/^\/revisions\/(\d+)/, 'REVISION'],
  [/^\/bom-lines\/(\d+)/, 'BOM_LINE'],
  [/^\/bom-line-alternates\/(\d+)/, 'BOM_LINE_ALTERNATE'],
  [/^\/process-plans\/(\d+)/, 'PROCESS_PLAN'],
  [/^\/operations\/(\d+)/, 'OPERATION'],
  [/^\/operation-materials\/(\d+)/, 'OPERATION_MATERIAL'],
  [/^\/ecns\/(\d+)/, 'ECN'],
  [/^\/ecn-items\/(\d+)/, 'ECN_ITEM'],
  [/^\/ecn-reviews\/(\d+)/, 'ECN_REVIEW'],
  [/^\/ecrs\/(\d+)/, 'ECR'],
  [/^\/documents\/(\d+)/, 'DOCUMENT'],
  [/^\/document-versions\/(\d+)/, 'DOCUMENT'],
  [/^\/document-links\/(\d+)/, 'DOCUMENT_LINK'],
  [/^\/manufacturers\/(\d+)/, 'MANUFACTURER'],
  [/^\/manufacturer-parts\/(\d+)/, 'MANUFACTURER_PART'],
  [/^\/baselines\/(\d+)/, 'BASELINE'],
  [/^\/attribute-defs\/(\d+)/, 'ATTRIBUTE_DEF'],
  [/^\/users\/(\d+)/, 'USER'],
  // Collection creates (no id in path):
  [/^\/parts/, 'PART'],
  [/^\/ecns/, 'ECN'],
  [/^\/ecrs/, 'ECR'],
  [/^\/documents/, 'DOCUMENT'],
  [/^\/manufacturers/, 'MANUFACTURER'],
  [/^\/baselines/, 'BASELINE'],
  [/^\/attribute-defs/, 'ATTRIBUTE_DEF'],
];

function deriveEntity(path: string): { entityType: string | null; entityId: number | null } {
  for (const [pattern, entityType] of ENTITY_PATTERNS) {
    const match = path.match(pattern);
    if (match) {
      return { entityType, entityId: match[1] ? Number(match[1]) : null };
    }
  }
  return { entityType: null, entityId: null };
}

/**
 * Walks the whole body, not just its top level.
 *
 * The old version replaced values on the first level and copied everything below it through
 * untouched, so `{credentials: {apiKey: "..."}}` was recorded in full. It also ran on arrays
 * by returning them verbatim.
 *
 * REDACTED, NOT REMOVED. The key stays with `'[redacted]'` in place of its value, because the
 * audit trail's job is to say what happened: "they set a key" is the fact being recorded, and
 * a field that vanishes reads as a field that was never sent.
 */
function scrub(value: unknown, depth: number): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const clean: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    clean[key] = isSensitiveName(key) ? '[redacted]' : scrub(inner, depth + 1);
  }
  return clean;
}

function sanitize(body: unknown): Prisma.InputJsonValue | undefined {
  if (body === null || body === undefined || typeof body !== 'object') return undefined;
  return scrub(body, 0) as Prisma.InputJsonValue;
}

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const userId = req.user?.id ?? null;
  const path = req.path;
  const method = req.method;
  const details = sanitize(req.body);

  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const { entityType, entityId } = deriveEntity(path);
    const summary = `${method} ${path}`;
    prisma.auditLog
      .create({
        data: {
          userId,
          method,
          path,
          entityType,
          entityId,
          summary,
          ...(details !== undefined ? { details } : {}),
        },
      })
      .catch((err) => console.error('Audit log write failed:', err));
  });
  next();
}
