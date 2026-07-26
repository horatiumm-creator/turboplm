import crypto from 'crypto';
import { Prisma, WebhookDeliveryStatus } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Outbound webhooks. Domain code calls emitEvent() inside its transaction; a
 * background dispatcher then POSTs each pending delivery with an HMAC-SHA256
 * signature so receivers can verify authenticity. Delivery never affects the
 * business transaction: rows are queued, sent later, and retried with a cap.
 */

export const WEBHOOK_EVENTS = [
  'part.released',
  'revision.released',
  'ecn.submitted',
  'ecn.approved',
  'ecn.released',
  'ecr.raised',
  'document.created',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 5;
const DISPATCH_INTERVAL_MS = 20000;

type Db = Prisma.TransactionClient | typeof prisma;

/** Queue a delivery for every active webhook subscribed to this event. */
export async function emitEvent(
  db: Db,
  event: WebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  const hooks = await db.webhook.findMany({ where: { active: true } });
  const subscribed = hooks.filter((hook) =>
    hook.events
      .split(',')
      .map((e) => e.trim())
      .includes(event)
  );
  if (subscribed.length === 0) return;
  await db.webhookDelivery.createMany({
    data: subscribed.map((hook) => ({
      webhookId: hook.id,
      event,
      payload: { event, sentAt: new Date().toISOString(), data: payload } as Prisma.InputJsonValue,
    })),
  });
}

export function signPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

let dispatching = false;

/** One dispatcher pass: POST pending deliveries, mark success/failure. */
export async function dispatchPendingWebhooks(): Promise<void> {
  if (dispatching) return;
  dispatching = true;
  try {
    const pending = await prisma.webhookDelivery.findMany({
      where: { status: WebhookDeliveryStatus.PENDING, attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { id: 'asc' },
      take: 20,
      include: { webhook: true },
    });
    for (const delivery of pending) {
      const body = JSON.stringify(delivery.payload);
      const attempts = delivery.attempts + 1;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(delivery.webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-TurboPLM-Event': delivery.event,
            'X-TurboPLM-Signature': `sha256=${signPayload(delivery.webhook.secret, body)}`,
            'X-TurboPLM-Delivery': String(delivery.id),
          },
          body,
          signal: controller.signal,
        }).finally(() => clearTimeout(timeout));

        if (res.ok) {
          await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status: WebhookDeliveryStatus.SUCCESS,
              attempts,
              responseCode: res.status,
              deliveredAt: new Date(),
              error: null,
            },
          });
        } else {
          await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status:
                attempts >= MAX_ATTEMPTS
                  ? WebhookDeliveryStatus.FAILED
                  : WebhookDeliveryStatus.PENDING,
              attempts,
              responseCode: res.status,
              error: `HTTP ${res.status}`,
            },
          });
        }
      } catch (err) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status:
              attempts >= MAX_ATTEMPTS
                ? WebhookDeliveryStatus.FAILED
                : WebhookDeliveryStatus.PENDING,
            attempts,
            error: err instanceof Error ? err.message.slice(0, 400) : 'Delivery failed',
          },
        });
      }
    }
  } catch (err) {
    console.error('Webhook dispatcher pass failed:', err);
  } finally {
    dispatching = false;
  }
}

export function startWebhookDispatcher(): void {
  setInterval(() => {
    void dispatchPendingWebhooks();
  }, DISPATCH_INTERVAL_MS).unref();
}
