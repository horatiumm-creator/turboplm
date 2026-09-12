import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Automatic audit trail: every successful (2xx) mutating /api call is logged with
 * the acting user, method, path, a derived entity reference, and the sanitized
 * request body. Mounted after requireAuth so req.user is set.
 */

const SENSITIVE_KEYS = new Set(['password', 'passwordHash', 'token', 'secret']);

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

function sanitize(body: unknown): Prisma.InputJsonValue | undefined {
  if (body === null || body === undefined || typeof body !== 'object') return undefined;
  if (Array.isArray(body)) return body as Prisma.InputJsonValue;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    clean[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : value;
  }
  return clean as Prisma.InputJsonValue;
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
