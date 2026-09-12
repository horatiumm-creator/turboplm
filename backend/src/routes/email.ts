import { Router } from 'express';
import { asyncHandler, HttpError } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { emailConfigured, emailStatus, sendTestEmail } from '../lib/mailer';

const router = Router();
router.use(requireAuth);

// GET /email/status — is SMTP configured (admin page display). Admin-only: it
// discloses the relay host and sending mailbox.
router.get('/email/status', (req, res) => {
  requireAdmin(req);
  res.json(emailStatus());
});

// POST /email/test — send a test email to the calling admin's own address.
router.post(
  '/email/test',
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    if (!emailConfigured()) {
      throw new HttpError(409, 'SMTP is not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS in .env');
    }
    try {
      await sendTestEmail(req.user!.email);
    } catch (err) {
      throw new HttpError(
        502,
        `SMTP send failed: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
    res.json({ ok: true, to: req.user!.email });
  })
);

export default router;
