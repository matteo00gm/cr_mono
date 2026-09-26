import { createHmac, randomUUID } from 'node:crypto';
import process from 'node:process';
import {
  createAuth,
  hashBackupCode,
  TOTP_PERIOD_SECONDS,
  type TwoFactorChange,
} from '@catalogorosso/core';
import { readMembershipsForUser } from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { createKeysPort } from '../src/keys.js';
import { AUTH_PUBLIC_PATH, DASHBOARD_PREFIX } from '../src/routes.js';

/**
 * Two-factor authentication against the real Better Auth and real Postgres
 * (P4-11).
 *
 * **Every assertion here is about the plugin's actual behaviour**, which is why
 * none of it can be a unit test. Reading the plugin's source found five places
 * where it does less than the row requires; each is closed in
 * `packages/core/src/auth-mfa.ts` and each is proved here against the pinned
 * library — so an upgrade that renames a path, or changes what a hook receives,
 * fails this suite rather than quietly reopening the gap.
 */

const SECRET = `mfa-suite-${randomUUID()}`;

let harness: TestDatabase | undefined;
let app: ReturnType<typeof createApp>;
const changes: TwoFactorChange[] = [];

/** A browser: whatever cookies the server set, sent back on the next request. */
class Jar {
  private readonly cookies = new Map<string, string>();

  take(response: Response): Response {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();

      if (value === '' || /max-age=0/iu.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    return response;
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async post(path: string, body: unknown = {}): Promise<Response> {
    return this.take(
      await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: this.header() },
        body: JSON.stringify(body),
      }),
    );
  }

  async get(path: string): Promise<Response> {
    return this.take(await app.request(path, { headers: { cookie: this.header() } }));
  }
}

/* ---- TOTP, computed here so the suite trusts nothing of the library's --- */

const base32 = (text: string): Buffer => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of text.replace(/=+$/u, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(out);
};

const hotp = (key: Buffer, counter: number): string => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  const binary =
    (((digest[offset] ?? 0) & 127) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);

  return String(binary % 1_000_000).padStart(6, '0');
};

const stepNow = (): number => Math.floor(Date.now() / (TOTP_PERIOD_SECONDS * 1000));

const keyOf = (totpURI: string): Buffer =>
  base32(new URL(totpURI).searchParams.get('secret') ?? '');

/* ---- an owner, a winery, and an enrolled authenticator ------------------ */

interface Owner {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly jar: Jar;
  key: Buffer;
  backupCodes: string[];
}

const admin = () => {
  if (harness === undefined) throw new Error('no database');
  return harness.adminDb;
};

const signUp = async (): Promise<Owner> => {
  const jar = new Jar();
  const email = `owner-${randomUUID()}@cantina.example`;
  const password = `password-${randomUUID()}`;

  const response = await jar.post(`${AUTH_PUBLIC_PATH}/sign-up/email`, {
    name: 'Owner',
    email,
    password,
  });
  expect(response.status).toBe(200);

  const [user] = [
    ...(await admin().execute(sql`SELECT id FROM auth_users WHERE email = ${email}`)),
  ] as { id: string }[];
  const tenantId = randomUUID();

  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status) VALUES (${tenantId}, 'Cantina', ${`c-${tenantId}`}, 'ACTIVE')
  `);
  await admin().execute(sql`
    INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenantId}, ${user?.id ?? ''}, 'OWNER')
  `);

  await jar.post(`${AUTH_PUBLIC_PATH}/sign-in/email`, { email, password });

  return {
    email,
    password,
    userId: user?.id ?? '',
    tenantId,
    jar,
    key: Buffer.alloc(0),
    backupCodes: [],
  };
};

/** Turns on TOTP and proves it with a code, as the enrolment screen does. */
const enrol = async (owner: Owner): Promise<void> => {
  const enabled = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/enable`, {
    password: owner.password,
  });
  expect(enabled.status).toBe(200);

  const { totpURI, backupCodes } = (await enabled.json()) as {
    totpURI: string;
    backupCodes: string[];
  };

  owner.key = keyOf(totpURI);
  owner.backupCodes = backupCodes;

  const verified = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/verify-totp`, {
    code: hotp(owner.key, stepNow()),
  });
  expect(verified.status).toBe(200);
};

/** A fresh browser, signed in through the second factor with `code`. */
const signInWith = async (
  owner: Owner,
  code: { totp: string } | { backup: string },
): Promise<{ jar: Jar; status: number; body: unknown }> => {
  const jar = new Jar();
  const first = await jar.post(`${AUTH_PUBLIC_PATH}/sign-in/email`, {
    email: owner.email,
    password: owner.password,
  });
  expect(((await first.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);

  const response =
    'totp' in code
      ? await jar.post(`${AUTH_PUBLIC_PATH}/two-factor/verify-totp`, { code: code.totp })
      : await jar.post(`${AUTH_PUBLIC_PATH}/two-factor/verify-backup-code`, { code: code.backup });

  return { jar, status: response.status, body: await response.json() };
};

const lastVerified = async (userId: string): Promise<unknown[]> =>
  [
    ...(await admin().execute(sql`
      SELECT last_verified_at FROM auth_sessions WHERE user_id = ${userId} ORDER BY created_at DESC
    `)),
  ].map((row) => (row as { last_verified_at: unknown }).last_verified_at);

/** Moves every one of the owner's verifications back past the step-up window. */
const goStale = async (userId: string): Promise<void> => {
  await admin().execute(sql`
    UPDATE auth_sessions SET last_verified_at = now() - interval '16 minutes' WHERE user_id = ${userId}
  `);
};

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  app = createApp({
    auth: createAuth({
      secret: SECRET,
      baseUrl: 'http://localhost',
      basePath: AUTH_PUBLIC_PATH,
      sendResetPassword: () => Promise.resolve(),
      /*
       * Every request here comes from one address, and outside production
       * Better Auth resolves every address to 127.0.0.1 anyway (P0-46) — so
       * its limits would stop this suite after a handful of sign-ups. The
       * limits are P0-46's to prove; the account lockout, which is this row's,
       * does not go through this store.
       */
      rateLimitStorage: { consume: () => Promise.resolve({ allowed: true, retryAfter: null }) },
      onTwoFactorChange: (change) => {
        changes.push(change);
        return Promise.resolve();
      },
    }),
    readMemberships: readMembershipsForUser,
    keys: createKeysPort(),
  });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an owner who has not enrolled', () => {
  it('is sent to enrol from an OWNER-only route, and can still reach the catalogue', async () => {
    const owner = await signUp();

    const keys = await owner.jar.get(`${DASHBOARD_PREFIX}/keys`);
    const catalogue = await owner.jar.get(`${DASHBOARD_PREFIX}/context`);

    expect(keys.status).toBe(403);
    expect(((await keys.json()) as { error: { code: string } }).error.code).toBe('mfa_required');
    expect(catalogue.status).toBe(200);
  });

  it('reaches it once enrolled', async () => {
    const owner = await signUp();

    await enrol(owner);
    await owner.jar.post(`${DASHBOARD_PREFIX}/keys`);

    expect((await owner.jar.get(`${DASHBOARD_PREFIX}/keys`)).status).toBe(200);
  });
});

describe('enrolment', () => {
  it('stores the backup codes as hashes, never as the codes or anything that decrypts to them', async () => {
    /* (1) The plugin's default is encryption: readable by whoever holds the secret. */
    const owner = await signUp();
    await enrol(owner);

    const [row] = [
      ...(await admin().execute(sql`
        SELECT backup_codes FROM auth_two_factor WHERE user_id = ${owner.userId}
      `)),
    ] as { backup_codes: string }[];
    const stored = JSON.parse(row?.backup_codes ?? '[]') as string[];

    expect(owner.backupCodes).toHaveLength(10);
    expect(stored).toEqual(owner.backupCodes.map((code) => hashBackupCode(SECRET, code)));
    for (const code of owner.backupCodes) expect(row?.backup_codes).not.toContain(code);
  });

  it('stamps the new session as just verified', async () => {
    const owner = await signUp();
    await enrol(owner);

    expect((await lastVerified(owner.userId))[0]).not.toBeNull();
  });

  it('is recorded, once', async () => {
    const owner = await signUp();
    await enrol(owner);

    expect(changes.filter((change) => change.userId === owner.userId)).toEqual([
      { userId: owner.userId, event: 'enabled' },
    ]);
  });
});

describe('a TOTP code', () => {
  it('signs in once, and is refused on replay while the plugin would still accept it', async () => {
    /*
     * (2) The case a phishing proxy relies on. Both sign-ins fall inside one
     * window — the plugin alone accepts the second — so the refusal is ours.
     */
    const owner = await signUp();
    await enrol(owner);

    const code = hotp(owner.key, stepNow() + 1);
    const first = await signInWith(owner, { totp: code });
    const replay = await signInWith(owner, { totp: code });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ code: 'INVALID_CODE' });
  });

  it('answers a replay exactly as it answers a wrong code', async () => {
    const owner = await signUp();
    await enrol(owner);

    const code = hotp(owner.key, stepNow() - 1);
    await signInWith(owner, { totp: code });

    const replay = await signInWith(owner, { totp: code });
    const wrong = await signInWith(owner, { totp: code === '000000' ? '111111' : '000000' });

    expect(replay.status).toBe(wrong.status);
    expect(replay.body).toEqual(wrong.body);
  });

  it('is accepted one step either side of now, and no further', async () => {
    /* Mid-step, so the steps below cannot move under the test. */
    const owner = await signUp();
    await enrol(owner);

    const period = TOTP_PERIOD_SECONDS * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.now() / period) * period + period / 2);

    const step = stepNow();

    expect((await signInWith(owner, { totp: hotp(owner.key, step - 1) })).status).toBe(200);
    expect((await signInWith(owner, { totp: hotp(owner.key, step + 1) })).status).toBe(200);
    expect((await signInWith(owner, { totp: hotp(owner.key, step + 2) })).status).toBe(401);
    expect((await signInWith(owner, { totp: hotp(owner.key, step - 2) })).status).toBe(401);
  });

  it('stamps the session it signs in', async () => {
    const owner = await signUp();
    await enrol(owner);
    await owner.jar.post(`${AUTH_PUBLIC_PATH}/sign-out`);
    await admin().execute(sql`DELETE FROM auth_sessions WHERE user_id = ${owner.userId}`);

    await signInWith(owner, { totp: hotp(owner.key, stepNow() + 1) });

    expect(await lastVerified(owner.userId)).toHaveLength(1);
    expect((await lastVerified(owner.userId))[0]).not.toBeNull();
  });
});

describe('a backup code', () => {
  it('signs in once and never again', async () => {
    const owner = await signUp();
    await enrol(owner);

    const [code = ''] = owner.backupCodes;

    expect((await signInWith(owner, { backup: code })).status).toBe(200);
    expect((await signInWith(owner, { backup: code })).status).toBe(401);
  });

  it('cannot be replaced by its own stored hash', async () => {
    /* The hash is what a database dump holds. Presented as a code, it is hashed again. */
    const owner = await signUp();
    await enrol(owner);

    const [code = ''] = owner.backupCodes;

    expect((await signInWith(owner, { backup: hashBackupCode(SECRET, code) })).status).toBe(401);
  });
});

describe('a sensitive action', () => {
  it('passes from a session that proved a second factor just now', async () => {
    const owner = await signUp();
    await enrol(owner);

    expect((await owner.jar.post(`${DASHBOARD_PREFIX}/keys`)).status).toBe(201);
  });

  it('is challenged once that proof is older than fifteen minutes', async () => {
    const owner = await signUp();
    await enrol(owner);
    await goStale(owner.userId);

    const response = await owner.jar.post(`${DASHBOARD_PREFIX}/keys`);

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'step_up_required',
    );
  });

  it('reads the session row, not the five-minute cookie cache', async () => {
    /*
     * **The property the row names.** The cookie cache was filled a moment ago
     * by a fresh session, and still says so. Only the row went stale — so a
     * check that trusted the cache would let this through.
     */
    const owner = await signUp();
    await enrol(owner);
    expect((await owner.jar.get(`${DASHBOARD_PREFIX}/me`)).status).toBe(200);

    await goStale(owner.userId);

    expect((await owner.jar.post(`${DASHBOARD_PREFIX}/keys`)).status).toBe(403);
  });

  it('passes again after a step-up code', async () => {
    const owner = await signUp();
    await enrol(owner);
    await goStale(owner.userId);

    const stepUp = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/verify-totp`, {
      code: hotp(owner.key, stepNow() + 1),
    });

    expect(stepUp.status).toBe(200);
    expect((await owner.jar.post(`${DASHBOARD_PREFIX}/keys`)).status).toBe(201);
  });

  it('is refused for a session revoked since its cookie was cached', async () => {
    const owner = await signUp();
    await enrol(owner);
    expect((await owner.jar.get(`${DASHBOARD_PREFIX}/me`)).status).toBe(200);

    await admin().execute(sql`DELETE FROM auth_sessions WHERE user_id = ${owner.userId}`);

    /* The cache still vouches for it — which is what makes the refusal below the row's. */
    expect((await owner.jar.get(`${DASHBOARD_PREFIX}/me`)).status).toBe(200);

    expect((await owner.jar.post(`${DASHBOARD_PREFIX}/keys`)).status).toBe(401);
  });
});

describe('guessing a step-up code with a stolen session', () => {
  it('locks the account after ten misses, even for the right code', async () => {
    /*
     * (3) With a session the plugin counts nothing. Without this budget, a
     * stolen cookie guesses at the path limit for as long as it likes.
     */
    const owner = await signUp();
    await enrol(owner);

    const right = hotp(owner.key, stepNow() + 1);
    const wrong = right === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await admin().execute(sql`DELETE FROM auth_totp_claims WHERE user_id = ${owner.userId}`);
      await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/verify-totp`, { code: wrong });
    }

    const locked = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/verify-totp`, {
      code: right,
    });

    expect(locked.status).toBe(429);
  });
});

describe('changing the second factor itself', () => {
  it('re-enrolling a new authenticator needs a step-up first', async () => {
    /* (4) Otherwise a stolen session plus the password swaps in the thief's app. */
    const owner = await signUp();
    await enrol(owner);
    await goStale(owner.userId);

    const response = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/enable`, {
      password: owner.password,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('reading out the live secret needs a step-up first', async () => {
    /*
     * The quiet version of the takeover: copy the authenticator and change
     * nothing, so there is no new-device event for the owner to notice.
     */
    const owner = await signUp();
    await enrol(owner);

    const fresh = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/get-totp-uri`, {
      password: owner.password,
    });
    await goStale(owner.userId);
    const stale = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/get-totp-uri`, {
      password: owner.password,
    });

    expect(fresh.status).toBe(200);
    expect(stale.status).toBe(403);
    expect(JSON.stringify(await stale.json())).not.toContain('otpauth');
  });

  it('regenerating backup codes needs a step-up first', async () => {
    const owner = await signUp();
    await enrol(owner);
    await goStale(owner.userId);

    const response = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/generate-backup-codes`, {
      password: owner.password,
    });

    expect(response.status).toBe(403);
  });

  it('disabling needs a step-up first', async () => {
    const owner = await signUp();
    await enrol(owner);
    await goStale(owner.userId);

    const response = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/disable`, {
      password: owner.password,
    });

    expect(response.status).toBe(403);
  });

  it('disables from a fresh session, and the change is recorded', async () => {
    const owner = await signUp();
    await enrol(owner);

    const response = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/disable`, {
      password: owner.password,
    });

    expect(response.status).toBe(200);
    expect(changes.filter((change) => change.userId === owner.userId)).toEqual([
      { userId: owner.userId, event: 'enabled' },
      { userId: owner.userId, event: 'disabled' },
    ]);
  });

  it('records a replaced authenticator as its own event', async () => {
    const owner = await signUp();
    await enrol(owner);

    const response = await owner.jar.post(`${AUTH_PUBLIC_PATH}/two-factor/enable`, {
      password: owner.password,
    });

    expect(response.status).toBe(200);
    expect(changes.filter((change) => change.userId === owner.userId).at(-1)).toEqual({
      userId: owner.userId,
      event: 'replaced',
    });
  });
});
