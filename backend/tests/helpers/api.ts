/**
 * In-process HTTP client and user fixtures.
 *
 * The suite drives the real Express app through supertest rather than a live server, so
 * middleware, routing and error mapping are all exercised while the tests stay in one
 * process with the Prisma client they assert against.
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Role } from '@prisma/client';
import app from '../../src/index';
import { prisma } from '../../src/lib/prisma';

export const DEFAULT_PASSWORD = 'correct-horse-battery';

/** Cost 4, not the production 10: ~200 logins per run, and nothing here is a secret. */
const TEST_BCRYPT_COST = 4;

export interface TestUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  password: string | null;
}

let userSeq = 0;

export async function createUser(options: {
  role?: Role;
  name?: string;
  email?: string;
  /** null creates a Google-style account with no password (the EMAIL_CONFIRM path). */
  password?: string | null;
} = {}): Promise<TestUser> {
  userSeq += 1;
  const role = options.role ?? Role.ENGINEER;
  const email = options.email ?? `user${userSeq}.${role.toLowerCase()}@turboplm.test`;
  const name = options.name ?? `${role[0]}${role.slice(1).toLowerCase()} ${userSeq}`;
  const password = options.password === undefined ? DEFAULT_PASSWORD : options.password;

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      name,
      role,
      provider: password === null ? 'GOOGLE' : 'LOCAL',
      ...(password === null ? { googleId: `google-${userSeq}-${Date.now()}` } : {}),
      passwordHash: password === null ? null : await bcrypt.hash(password, TEST_BCRYPT_COST),
    },
  });
  return { id: user.id, email: user.email, name: user.name, role, password };
}

/** A supertest wrapper that carries one user's session cookie. */
export class Client {
  constructor(
    readonly user: TestUser,
    private readonly cookie: string
  ) {}

  get id(): number {
    return this.user.id;
  }

  get(path: string) {
    return request(app).get(path).set('Cookie', this.cookie);
  }

  post(path: string, body?: unknown) {
    const req = request(app).post(path).set('Cookie', this.cookie);
    return body === undefined ? req : req.send(body as object);
  }

  patch(path: string, body?: unknown) {
    const req = request(app).patch(path).set('Cookie', this.cookie);
    return body === undefined ? req : req.send(body as object);
  }

  put(path: string, body?: unknown) {
    const req = request(app).put(path).set('Cookie', this.cookie);
    return body === undefined ? req : req.send(body as object);
  }

  delete(path: string) {
    return request(app).delete(path).set('Cookie', this.cookie);
  }
}

/** Log in over the real auth route, so the cookie is one the app actually issued. */
export async function login(user: TestUser): Promise<Client> {
  if (user.password === null) {
    throw new Error(`${user.email} has no password — use loginWithoutPassword for OAuth accounts`);
  }
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });
  if (res.status !== 200) {
    throw new Error(`login failed for ${user.email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : [raw];
  const cookie = cookies.find((c) => typeof c === 'string' && c.startsWith('turboplm_token='));
  if (!cookie) throw new Error(`login for ${user.email} did not set a session cookie`);
  return new Client(user, cookie.split(';')[0]);
}

/**
 * Session for a password-less (Google) account: the login route cannot authenticate it,
 * so the cookie is minted the same way `setAuthCookie` does.
 */
export function loginWithoutPassword(user: TestUser): Client {
  // Deliberately not importing jsonwebtoken twice — the middleware's own secret is used.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
  const token = jwt.sign({ sub: String(user.id) }, process.env.JWT_SECRET || 'dev-secret-change-me', {
    expiresIn: '7d',
  });
  return new Client(user, `turboplm_token=${token}`);
}

export async function createAndLogin(options: Parameters<typeof createUser>[0] = {}): Promise<Client> {
  return login(await createUser(options));
}

/** The usual cast: one of each role, all logged in. */
export async function loginAllRoles(): Promise<{
  admin: Client;
  engineer: Client;
  viewer: Client;
}> {
  const [admin, engineer, viewer] = await Promise.all([
    createAndLogin({ role: Role.ADMIN }),
    createAndLogin({ role: Role.ENGINEER }),
    createAndLogin({ role: Role.VIEWER }),
  ]);
  return { admin, engineer, viewer };
}

/**
 * A supertest wrapper carrying a *portal* session — deliberately a separate class from
 * `Client` so a test can never accidentally reach an internal route with a supplier
 * session or vice versa. Crossing the two is what the P1 tests assert is impossible, so
 * the fixtures must not blur it either.
 */
export class PortalClient {
  constructor(
    readonly account: { id: number; email: string; supplierId: number },
    private readonly cookie: string
  ) {}

  get(path: string) {
    return request(app).get(path).set('Cookie', this.cookie);
  }

  post(path: string, body?: unknown) {
    const req = request(app).post(path).set('Cookie', this.cookie);
    return body === undefined ? req : req.send(body as object);
  }

  delete(path: string) {
    return request(app).delete(path).set('Cookie', this.cookie);
  }

  /** The raw cookie, for the tests that replay it against the internal API. */
  get rawCookie(): string {
    return this.cookie;
  }
}

export const PORTAL_PASSWORD = 'supplier-portal-password';

/**
 * Create a supplier portal account and accept its invitation over the real routes, so the
 * cookie under test is one the app actually issued.
 */
export async function createPortalAccount(options: {
  supplierId: number;
  email?: string;
  name?: string;
  invitedBy: Client;
}): Promise<PortalClient> {
  userSeq += 1;
  const email = options.email ?? `supplier${userSeq}@vendor.test`;
  const invite = await options.invitedBy.post(`/api/suppliers/${options.supplierId}/users`, {
    email,
    name: options.name ?? `Supplier Contact ${userSeq}`,
  });
  if (invite.status !== 201) {
    throw new Error(`invite failed: ${invite.status} ${JSON.stringify(invite.body)}`);
  }
  const token = String(invite.body.inviteUrl ?? '').split('=').pop();
  if (!token) throw new Error('invite response carried no token');

  const accepted = await request(app)
    .post('/api/portal/accept-invite')
    .send({ token, password: PORTAL_PASSWORD });
  if (accepted.status !== 200) {
    throw new Error(`accept-invite failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  }
  const raw = accepted.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : [raw];
  const cookie = cookies.find((c) => typeof c === 'string' && c.startsWith('turboplm_portal='));
  if (!cookie) throw new Error('accept-invite did not set a portal cookie');

  return new PortalClient(
    { id: accepted.body.id, email, supplierId: options.supplierId },
    cookie.split(';')[0]
  );
}

export { app, request };
