import nodemailer, { Transporter } from 'nodemailer';
import { prisma } from './prisma';

/**
 * SMTP email delivery. Configured entirely via environment:
 *   SMTP_HOST   e.g. smtp.office365.com (Microsoft 365)
 *   SMTP_PORT   default 587 (STARTTLS)
 *   SMTP_SECURE 'true' only for implicit TLS (port 465); M365 uses STARTTLS => false
 *   SMTP_USER / SMTP_PASS   mailbox credentials (M365: SMTP AUTH must be enabled)
 *   SMTP_FROM   defaults to SMTP_USER
 *   PUBLIC_URL  used to build absolute links in emails
 *
 * Delivery is an outbox on the Notification table: rows with emailedAt = null are
 * picked up by the dispatcher after the business transaction committed, so email
 * can never fail or delay a PLM operation.
 */

const HOST = process.env.SMTP_HOST || '';
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.SMTP_FROM || USER;
const PORT = Number(process.env.SMTP_PORT || 587);
const SECURE = process.env.SMTP_SECURE === 'true';
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3010';

/** Only send email for notifications younger than this — avoids a flood when SMTP is configured later. */
const MAX_AGE_MS = 60 * 60 * 1000;
const BATCH_SIZE = 20;

let transporter: Transporter | null = null;

export function emailConfigured(): boolean {
  return Boolean(HOST && USER && PASS);
}

export function emailStatus(): { configured: boolean; host: string | null; from: string | null } {
  return {
    configured: emailConfigured(),
    host: emailConfigured() ? HOST : null,
    from: emailConfigured() ? FROM : null,
  };
}

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: SECURE,
      auth: { user: USER, pass: PASS },
    });
  }
  return transporter;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderEmail(title: string, body: string | null, link: string | null): string {
  const url = link ? `${PUBLIC_URL}${link}` : PUBLIC_URL;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <div style="font-size:13px;letter-spacing:2px;color:#1e6fd9;font-weight:700;margin-bottom:16px">TURBOPLM</div>
  <div style="font-size:16px;font-weight:600;color:#1a1a1a;margin-bottom:8px">${escapeHtml(title)}</div>
  ${body ? `<div style="font-size:14px;color:#555;margin-bottom:16px">${escapeHtml(body)}</div>` : ''}
  <a href="${escapeHtml(url)}" style="display:inline-block;background:#1e6fd9;color:#fff;text-decoration:none;padding:8px 18px;border-radius:6px;font-size:14px">Open in TurboPLM</a>
  <div style="font-size:12px;color:#999;margin-top:24px">You received this because of your role on this item in TurboPLM.</div>
</div>`;
}

export async function sendTestEmail(to: string): Promise<void> {
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: 'TurboPLM test email',
    html: renderEmail(
      'Email delivery is working',
      'This is a test message confirming your SMTP configuration.',
      null
    ),
  });
}

let dispatching = false;

/** One dispatcher pass: send pending notification emails, stamp emailedAt on success. */
export async function dispatchPendingEmails(): Promise<void> {
  if (!emailConfigured() || dispatching) return;
  dispatching = true;
  try {
    const cutoff = new Date(Date.now() - MAX_AGE_MS);
    // Age out anything older than the window so it is never retried.
    await prisma.notification.updateMany({
      where: { emailedAt: null, createdAt: { lt: cutoff } },
      data: { emailedAt: new Date(0) },
    });
    const pending = await prisma.notification.findMany({
      where: { emailedAt: null },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      include: { user: { select: { email: true } } },
    });
    // A single undeliverable recipient must not block the rest of the queue, so
    // failures skip to the next message. Repeated failures in one pass mean the
    // server (not the recipient) is unhappy — stop and retry on the next pass.
    let consecutiveFailures = 0;
    for (const notification of pending) {
      try {
        await getTransporter().sendMail({
          from: FROM,
          to: notification.user.email,
          subject: `[TurboPLM] ${notification.title}`,
          html: renderEmail(notification.title, notification.body, notification.link),
        });
        await prisma.notification.update({
          where: { id: notification.id },
          data: { emailedAt: new Date() },
        });
        consecutiveFailures = 0;
      } catch (err) {
        console.error(`Email send failed for notification ${notification.id}:`, err);
        // Leave emailedAt null — retried next pass until it ages out.
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          console.error('Email: 3 consecutive failures — pausing until the next pass');
          break;
        }
      }
    }
  } finally {
    dispatching = false;
  }
}

export function startEmailDispatcher(intervalMs = 30_000): void {
  if (!emailConfigured()) {
    console.log('Email: SMTP not configured — in-app notifications only');
    return;
  }
  console.log(`Email: dispatching via ${HOST} as ${FROM}`);
  setInterval(() => {
    void dispatchPendingEmails();
  }, intervalMs).unref();
}
