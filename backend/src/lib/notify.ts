import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

export interface NotificationInput {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Create the same notification for several users. The acting user is excluded —
 * you never get notified about your own action. Failures must not break the
 * business operation when called outside a transaction; inside one, the caller
 * decides (pass the tx to make delivery atomic with the action).
 */
export async function notifyUsers(
  db: Db,
  userIds: number[],
  actorId: number | null,
  input: NotificationInput
): Promise<void> {
  const recipients = [...new Set(userIds)].filter((id) => id !== actorId);
  if (recipients.length === 0) return;
  await db.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    })),
  });
}
