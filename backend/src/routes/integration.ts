import crypto from 'crypto';
import { URL } from 'url';
import { Request, Router } from 'express';
import { Prisma, WebhookDeliveryStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError, idParam } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { generateApiKey } from '../middleware/apikey';
import { WEBHOOK_EVENTS } from '../lib/webhooks';

/**
 * Integration surface (rules I1/I2): machine credentials (API keys) and outbound
 * webhooks. Everything here is administrator-only — the single exception is
 * GET /webhook-events, a static catalogue any signed-in user may read so the UI
 * can render the subscription picker.
 *
 * Secrets leave the server EXACTLY ONCE, in the response of the POST that mints
 * them: an API key's full string and a webhook's signing secret are never part
 * of any GET/PATCH payload (only the key prefix is stored in retrievable form —
 * the key itself is kept as a SHA-256 hash).
 */

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface UserRefDto {
  id: number;
  name: string;
}

type ApiKeyScope = 'read' | 'write';

interface ApiKeySummaryDto {
  id: number;
  name: string;
  prefix: string;
  scopes: ApiKeyScope;
  createdBy: UserRefDto;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Returned once, on creation only — the full key is never retrievable again. */
interface ApiKeyCreatedDto extends ApiKeySummaryDto {
  key: string;
}

interface WebhookDeliveryItemDto {
  id: number;
  event: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

interface WebhookSummaryDto {
  id: number;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  createdBy: UserRefDto;
  createdAt: string;
  recentDeliveries: WebhookDeliveryItemDto[];
}

/** Returned once, on creation only. */
interface WebhookCreatedDto extends WebhookSummaryDto {
  secret: string;
}

// ---------------------------------------------------------------------------
// Fetch helpers + mappers
// ---------------------------------------------------------------------------

/** How many deliveries ride along with each webhook in a listing. */
const RECENT_DELIVERIES = 5;

async function fetchApiKey(id: number) {
  return prisma.apiKey.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true } } },
  });
}

async function fetchApiKeys() {
  return prisma.apiKey.findMany({
    orderBy: { id: 'desc' },
    include: { createdBy: { select: { id: true, name: true } } },
  });
}

type ApiKeyRow = NonNullable<Awaited<ReturnType<typeof fetchApiKey>>>;

/** The column is a plain String; anything that isn't "write" reads as "read". */
function toScope(raw: string): ApiKeyScope {
  return raw === 'write' ? 'write' : 'read';
}

function toApiKeySummary(key: ApiKeyRow): ApiKeySummaryDto {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: toScope(key.scopes),
    createdBy: { id: key.createdBy.id, name: key.createdBy.name },
    lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString() : null,
    revokedAt: key.revokedAt ? key.revokedAt.toISOString() : null,
    createdAt: key.createdAt.toISOString(),
  };
}

async function getApiKeyOrThrow(id: number): Promise<ApiKeyRow> {
  const key = await fetchApiKey(id);
  if (!key) throw new HttpError(404, 'API key not found');
  return key;
}

async function fetchWebhook(id: number) {
  return prisma.webhook.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, name: true } },
      deliveries: { orderBy: { id: 'desc' }, take: RECENT_DELIVERIES },
    },
  });
}

async function fetchWebhooks() {
  return prisma.webhook.findMany({
    orderBy: { id: 'desc' },
    include: {
      createdBy: { select: { id: true, name: true } },
      deliveries: { orderBy: { id: 'desc' }, take: RECENT_DELIVERIES },
    },
  });
}

type WebhookRow = NonNullable<Awaited<ReturnType<typeof fetchWebhook>>>;
type WebhookDeliveryRow = WebhookRow['deliveries'][number];

function toWebhookDelivery(delivery: WebhookDeliveryRow): WebhookDeliveryItemDto {
  return {
    id: delivery.id,
    event: delivery.event,
    status: delivery.status,
    attempts: delivery.attempts,
    responseCode: delivery.responseCode,
    error: delivery.error,
    createdAt: delivery.createdAt.toISOString(),
    deliveredAt: delivery.deliveredAt ? delivery.deliveredAt.toISOString() : null,
  };
}

/** Events are stored comma-joined in one column; the DTO exposes a list. */
function splitEvents(raw: string): string[] {
  return raw
    .split(',')
    .map((event) => event.trim())
    .filter((event) => event !== '');
}

function toWebhookSummary(hook: WebhookRow): WebhookSummaryDto {
  return {
    id: hook.id,
    name: hook.name,
    url: hook.url,
    events: splitEvents(hook.events),
    active: hook.active,
    createdBy: { id: hook.createdBy.id, name: hook.createdBy.name },
    createdAt: hook.createdAt.toISOString(),
    recentDeliveries: hook.deliveries.map(toWebhookDelivery),
  };
}

async function getWebhookOrThrow(id: number): Promise<WebhookRow> {
  const hook = await fetchWebhook(id);
  if (!hook) throw new HttpError(404, 'Webhook not found');
  return hook;
}

// ---------------------------------------------------------------------------
// Validation helpers
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

function parseName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'name is required and must be a non-empty string');
  }
  const name = value.trim();
  if (name.length > 100) throw new HttpError(400, 'name must be at most 100 characters');
  return name;
}

function parseScopes(value: unknown): ApiKeyScope {
  if (value !== 'read' && value !== 'write') {
    throw new HttpError(400, 'scopes must be "read" or "write"');
  }
  return value;
}

function parseBooleanFlag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${label} must be a boolean`);
  return value;
}

/** WHATWG parse; only http(s) endpoints can be delivered to. */
function parseWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'url is required and must be a non-empty string');
  }
  const raw = value.trim();
  if (raw.length > 2000) throw new HttpError(400, 'url must be at most 2000 characters');
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new HttpError(400, 'url must be a valid http or https URL');
  }
  assertAllowedWebhookHost(parsed);
  return raw;
}

/**
 * The dispatcher POSTs from inside the API container, so an unrestricted URL
 * turns webhooks into a probe of the server's own network. Link-local (incl. the
 * cloud metadata endpoint) is always refused. Private/loopback ranges stay
 * allowed by default because on-prem ERP/MES targets legitimately live there —
 * set WEBHOOK_BLOCK_PRIVATE_HOSTS=true for internet-facing deployments.
 */
function assertAllowedWebhookHost(parsed: URL): void {
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  const isLinkLocal =
    host.startsWith('169.254.') || host === 'metadata.google.internal' || host.startsWith('fe80:');
  if (isLinkLocal) {
    throw new HttpError(400, 'That host is not allowed as a webhook target');
  }

  if (process.env.WEBHOOK_BLOCK_PRIVATE_HOSTS !== 'true') return;

  const isLoopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  const isPrivateV4 =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
  const isPrivateV6 = host.startsWith('fc') || host.startsWith('fd');
  const isInternalName = host.endsWith('.internal') || host.endsWith('.local') || !host.includes('.');
  if (isLoopback || isPrivateV4 || isPrivateV6 || isInternalName) {
    throw new HttpError(
      400,
      'Private and loopback webhook targets are disabled (WEBHOOK_BLOCK_PRIVATE_HOSTS)'
    );
  }
}

const KNOWN_EVENTS = new Set<string>(WEBHOOK_EVENTS);

/** Non-empty, every entry a known event; duplicates collapse, order preserved. */
function parseEvents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, 'events must be a non-empty array of event names');
  }
  const events: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new HttpError(400, 'events must be an array of event name strings');
    }
    if (!KNOWN_EVENTS.has(entry)) {
      throw new HttpError(400, `Unknown webhook event: ${entry}`);
    }
    if (!events.includes(entry)) events.push(entry);
  }
  return events;
}

// ---------------------------------------------------------------------------
// GET /api-keys — rule I1 (admin; never returns key material)
// ---------------------------------------------------------------------------

router.get(
  '/api-keys',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const keys = await fetchApiKeys();
    res.json(keys.map(toApiKeySummary));
  })
);

// ---------------------------------------------------------------------------
// POST /api-keys — mint a key, returning the full string exactly once (I1)
// ---------------------------------------------------------------------------

router.post(
  '/api-keys',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const body = requireBody(req);

    const name = parseName(body.name);
    const scopes = parseScopes(body.scopes);
    const userId = currentUserId(req);

    // The prefix is unique; a collision is astronomically unlikely but cheap to
    // retry, so regenerate rather than surfacing a 409 to the operator.
    const minted = await (async () => {
      for (let attempt = 0; ; attempt++) {
        const generated = generateApiKey();
        try {
          const row = await prisma.apiKey.create({
            data: {
              name,
              prefix: generated.prefix,
              keyHash: generated.hash,
              scopes,
              createdById: userId,
            },
            include: { createdBy: { select: { id: true, name: true } } },
          });
          return { row, key: generated.full };
        } catch (err) {
          if ((err as { code?: string } | null)?.code === 'P2002' && attempt < 3) continue;
          throw err;
        }
      }
    })();

    const payload: ApiKeyCreatedDto = { ...toApiKeySummary(minted.row), key: minted.key };
    res.status(201).json(payload);
  })
);

// ---------------------------------------------------------------------------
// POST /api-keys/:id/revoke — one-way, 409 when already revoked (I1)
// ---------------------------------------------------------------------------

router.post(
  '/api-keys/:id/revoke',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);

    const existing = await prisma.apiKey.findUnique({
      where: { id },
      select: { id: true, revokedAt: true },
    });
    if (!existing) throw new HttpError(404, 'API key not found');
    if (existing.revokedAt) throw new HttpError(409, 'API key is already revoked');

    // Conditional write: two concurrent revokes can't both report success.
    const result = await prisma.apiKey.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new HttpError(409, 'API key is already revoked');

    res.json(toApiKeySummary(await getApiKeyOrThrow(id)));
  })
);

// ---------------------------------------------------------------------------
// GET /webhook-events — subscription catalogue (rule I2; any signed-in user)
// ---------------------------------------------------------------------------

router.get('/webhook-events', (_req, res) => {
  const events: string[] = [...WEBHOOK_EVENTS];
  res.json(events);
});

// ---------------------------------------------------------------------------
// GET /webhooks — rule I2 (admin; secrets omitted)
// ---------------------------------------------------------------------------

router.get(
  '/webhooks',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const hooks = await fetchWebhooks();
    res.json(hooks.map(toWebhookSummary));
  })
);

// ---------------------------------------------------------------------------
// POST /webhooks — create, returning the signing secret exactly once (I2)
// ---------------------------------------------------------------------------

router.post(
  '/webhooks',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const body = requireBody(req);

    const name = parseName(body.name);
    const url = parseWebhookUrl(body.url);
    const events = parseEvents(body.events);
    const secret = crypto.randomBytes(24).toString('hex');

    const created = await prisma.webhook.create({
      data: {
        name,
        url,
        secret,
        events: events.join(','),
        createdById: currentUserId(req),
      },
      select: { id: true },
    });

    const payload: WebhookCreatedDto = {
      ...toWebhookSummary(await getWebhookOrThrow(created.id)),
      secret,
    };
    res.status(201).json(payload);
  })
);

// ---------------------------------------------------------------------------
// PATCH /webhooks/:id — rule I2 (secret is never rotated or disclosed here)
// ---------------------------------------------------------------------------

router.patch(
  '/webhooks/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);
    const body = requireBody(req);

    const existing = await prisma.webhook.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new HttpError(404, 'Webhook not found');

    const data: Prisma.WebhookUpdateInput = {};
    if ('name' in body) data.name = parseName(body.name);
    if ('url' in body) data.url = parseWebhookUrl(body.url);
    if ('events' in body) data.events = parseEvents(body.events).join(',');
    if ('active' in body) data.active = parseBooleanFlag(body.active, 'active');

    if (Object.keys(data).length > 0) {
      await prisma.webhook.update({ where: { id }, data });
    }

    res.json(toWebhookSummary(await getWebhookOrThrow(id)));
  })
);

// ---------------------------------------------------------------------------
// DELETE /webhooks/:id — deliveries cascade with the hook (I2)
// ---------------------------------------------------------------------------

router.delete(
  '/webhooks/:id',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);

    const existing = await prisma.webhook.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new HttpError(404, 'Webhook not found');

    await prisma.webhook.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// POST /webhooks/:id/test — queue one sample delivery to this hook only (I2)
// ---------------------------------------------------------------------------

router.post(
  '/webhooks/:id/test',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const id = idParam(req.params.id);

    const existing = await prisma.webhook.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new HttpError(404, 'Webhook not found');

    // Queued directly rather than via emitEvent: a test targets this one hook,
    // regardless of what it subscribes to. The dispatcher picks it up as usual.
    const event = 'part.released';
    const payload: Prisma.InputJsonValue = {
      event,
      sentAt: new Date().toISOString(),
      data: { sample: true },
    };
    await prisma.webhookDelivery.create({ data: { webhookId: id, event, payload } });

    res.json({ queued: true });
  })
);

export default router;
