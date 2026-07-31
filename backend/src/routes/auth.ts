import { Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes, timingSafeEqual } from 'crypto';
import { Role, User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError, asyncHandler } from '../lib/errors';
import { clearAuthCookie, requireAuth, setAuthCookie } from '../middleware/auth';

const router = Router();
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3010';

// ---------------------------------------------------------------------------
// OAuth CSRF protection (rule A1)
// ---------------------------------------------------------------------------

/** Short-lived, httpOnly: the browser echoes it back only to us. */
const OAUTH_STATE_COOKIE = 'turboplm_oauth';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SECURE_COOKIES = PUBLIC_URL.startsWith('https://');

/**
 * Issue a one-time `state` and remember it in an httpOnly cookie.
 *
 * Without this the callback accepted ANY authorization code presented to it, which is
 * login-CSRF: an attacker can complete the flow in a victim's browser and land them in the
 * attacker's session (or bind the attacker's identity to the victim's account). The cookie is
 * the second half of the pair — an attacker can put a code in the URL but cannot set our
 * cookie, so the two only agree for a flow this server actually started.
 */
function issueOauthState(res: Response): string {
  const state = randomBytes(32).toString('base64url');
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    maxAge: OAUTH_STATE_TTL_MS,
    path: '/api/auth',
  });
  return state;
}

/** One state, one callback: consumed whether or not it matched. */
function consumeOauthState(req: { cookies?: Record<string, string> }, res: Response): string | null {
  const stored = req.cookies?.[OAUTH_STATE_COOKIE] ?? null;
  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/auth' });
  return stored;
}

function toUserInfo(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    avatarUrl: u.avatarUrl,
    provider: u.provider,
  };
}

/**
 * Open self-registration is convenient locally but wrong for an internet-facing
 * instance, where it would hand write access to anyone. Set
 * ALLOW_REGISTRATION=false and have an admin create accounts instead.
 */
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== 'false';

/**
 * Role granted to anyone who signs themselves up (local or Google). Defaults to
 * VIEWER so a public instance cannot be edited by strangers; set
 * REGISTRATION_ROLE=ENGINEER for an open sandbox where visitors may change data.
 */
const REGISTRATION_ROLE: Role =
  process.env.REGISTRATION_ROLE === 'ENGINEER' ? Role.ENGINEER : Role.VIEWER;

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    if (!ALLOW_REGISTRATION) {
      throw new HttpError(403, 'Self-registration is disabled — ask an administrator for an account');
    }
    const { name, email, password } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim().length < 2)
      throw new HttpError(400, 'Name must be at least 2 characters');
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new HttpError(400, 'Invalid email address');
    if (typeof password !== 'string' || password.length < 8)
      throw new HttpError(400, 'Password must be at least 8 characters');
    const normalized = email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalized } });
    if (existing) throw new HttpError(409, 'An account with this email already exists');
    const user = await prisma.user.create({
      data: {
        email: normalized,
        name: name.trim(),
        passwordHash: await bcrypt.hash(password, 10),
        provider: 'LOCAL',
        role: REGISTRATION_ROLE,
      },
    });
    setAuthCookie(res, user.id);
    res.status(201).json(toUserInfo(user));
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof email !== 'string' || typeof password !== 'string')
      throw new HttpError(400, 'Email and password are required');
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash)))
      throw new HttpError(401, 'Invalid email or password');
    setAuthCookie(res, user.id);
    res.json(toUserInfo(user));
  })
);

router.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

router.get('/providers', (_req, res) => {
  res.json({
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    registration: ALLOW_REGISTRATION,
  });
});

router.get('/google', (_req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(400).json({ error: 'Google sign-in is not configured' });
    return;
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${PUBLIC_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state: issueOauthState(res),
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new HttpError(400, 'Google sign-in is not configured');

    // Checked before the code is exchanged: a mismatched state means this callback did not
    // come from a flow we started, and spending the code would be doing the attacker's work.
    const expectedState = consumeOauthState(req, res);
    const providedState = req.query.state;
    if (
      !expectedState ||
      typeof providedState !== 'string' ||
      providedState.length !== expectedState.length ||
      !timingSafeEqual(Buffer.from(providedState), Buffer.from(expectedState))
    ) {
      res.redirect('/login?error=state');
      return;
    }

    const code = req.query.code;
    if (typeof code !== 'string') {
      res.redirect('/login?error=google');
      return;
    }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${PUBLIC_URL}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      console.error('Google token exchange failed:', await tokenRes.text());
      res.redirect('/login?error=google');
      return;
    }
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) {
      res.redirect('/login?error=google');
      return;
    }
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!infoRes.ok) {
      res.redirect('/login?error=google');
      return;
    }
    const info = (await infoRes.json()) as {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (!info.email) {
      res.redirect('/login?error=google');
      return;
    }
    // An unverified address must never link to, or create, an account. The linking below
    // matches an existing user by email alone, so accepting an unverified one would let
    // whoever controls that address at the provider take over the matching TurboPLM account.
    // Google returns email_verified; every OIDC provider asserts it as an id_token claim.
    if (info.email_verified !== true) {
      res.redirect('/login?error=unverified');
      return;
    }
    const email = info.email.toLowerCase();
    let user = await prisma.user.findUnique({ where: { googleId: info.sub } });
    if (!user) {
      const byEmail = await prisma.user.findUnique({ where: { email } });
      user = byEmail
        ? await prisma.user.update({
            where: { id: byEmail.id },
            data: { googleId: info.sub, avatarUrl: byEmail.avatarUrl ?? info.picture ?? null },
          })
        : await prisma.user.create({
            data: {
              email,
              name: info.name ?? email,
              provider: 'GOOGLE',
              googleId: info.sub,
              avatarUrl: info.picture ?? null,
              role: REGISTRATION_ROLE,
            },
          });
    }
    setAuthCookie(res, user.id);
    res.redirect('/');
  })
);

export default router;
