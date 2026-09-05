import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuth, SESSION_COOKIE_CACHE_SECONDS, type AuthOptions } from '../src/auth.js';

/**
 * Better Auth configuration (P0-45).
 *
 * These assert the *configuration*, not the behaviour. Whether a session cookie
 * actually round-trips, whether the drizzle adapter can reach `auth_users`, and
 * whether a reset link resolves are all questions only a real database can
 * answer — `apps/api/test/auth.integration.test.ts` asks them.
 *
 * What is worth pinning here is the set of options where a wrong value is
 * silent: a cookie flag that quietly reverts to a default, a model name that
 * throws only at the first query, a cache TTL that is a deliberate trade rather
 * than a number somebody picked.
 *
 * A fake `DATABASE_URL` is enough because postgres-js is lazy — the client is
 * constructed when `createAuth` runs, and no socket opens until a query is
 * issued, which nothing here does.
 */

/** Better Auth exposes the resolved options; the narrow return type hides them. */
interface ConfiguredAuth {
  readonly options: {
    readonly basePath?: string;
    readonly user?: { modelName?: string };
    readonly session?: { modelName?: string; cookieCache?: { enabled?: boolean; maxAge?: number } };
    readonly account?: { modelName?: string };
    readonly verification?: { modelName?: string };
    readonly advanced?: {
      useSecureCookies?: boolean;
      defaultCookieAttributes?: { httpOnly?: boolean; sameSite?: string; secure?: boolean };
      ipAddress?: { ipAddressHeaders?: string[] };
    };
    readonly plugins?: { id: string }[];
    readonly rateLimit?: {
      enabled?: boolean;
      window?: number;
      max?: number;
      customRules?: Record<string, { window: number; max: number }>;
    };
  };
}

const options: AuthOptions = {
  secret: 'unit-suite-secret-not-used-to-sign-anything-real',
  baseUrl: 'https://dashboard.example.test',
  basePath: '/v1/dashboard/auth',
  sendResetPassword: () => Promise.resolve(),
};

const configure = (overrides: Partial<AuthOptions> = {}): ConfiguredAuth =>
  createAuth({ ...options, ...overrides }) as unknown as ConfiguredAuth;

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://app_rw:none@127.0.0.1:5432/none');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('table names', () => {
  it('point at the auth_ tables, because `user` is reserved in Postgres', () => {
    /*
     * The drizzle adapter resolves `schema[model]` by the *configured* model
     * name, so these strings and the keys in `authSchema` must match exactly.
     * A mismatch throws at the first query rather than at startup — which is
     * why it is worth asserting somewhere that runs in milliseconds.
     */
    const { options: resolved } = configure();

    expect(resolved.user?.modelName).toBe('auth_users');
    expect(resolved.session?.modelName).toBe('auth_sessions');
    expect(resolved.account?.modelName).toBe('auth_accounts');
    expect(resolved.verification?.modelName).toBe('auth_verifications');
  });
});

describe('cookies', () => {
  it('are HttpOnly, Secure and SameSite=Lax', () => {
    /*
     * All three together, because the set is the property. `HttpOnly` is
     * already Better Auth's default and is stated anyway — a reader checking
     * "are the cookie flags right" should not have to know which of them came
     * from a default and which was chosen.
     */
    const { advanced } = configure().options;

    expect(advanced?.useSecureCookies).toBe(true);
    expect(advanced?.defaultCookieAttributes).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
  });

  it('are Lax rather than Strict, so a reset link still works', () => {
    // `Strict` drops the cookie on any cross-site navigation *into* the
    // dashboard — including the link in a password-reset email, which is the
    // one journey where being signed out is most confusing.
    expect(configure().options.advanced?.defaultCookieAttributes?.sameSite).toBe('lax');
  });
});

describe('the session cookie cache', () => {
  it('is enabled, with the TTL that bounds a revocation', () => {
    /*
     * A trade, not a constant. The cache makes the common read cheap by
     * trusting a signed copy, which means an OWNER removing somebody has up to
     * this long before it takes effect on a cached read. P0-46 asserts the
     * bound; P4-11's step-up check reads the database directly to bypass it.
     */
    const { session } = configure().options;

    expect(session?.cookieCache?.enabled).toBe(true);
    expect(session?.cookieCache?.maxAge).toBe(SESSION_COOKIE_CACHE_SECONDS);
    expect(SESSION_COOKIE_CACHE_SECONDS).toBe(300);
  });
});

describe('basePath', () => {
  it('is whatever the caller mounted the app at', () => {
    /*
     * Not defaulted to `/auth`, and that is the bug this catches. Better Auth
     * is handed the raw `Request`, whose URL carries the whole path — so a
     * sub-app-relative prefix matches nothing once the app is mounted under
     * `/v1/dashboard`, and every auth endpoint 404s. It also builds reset and
     * callback URLs from `baseUrl + basePath`, so a merely route-correct value
     * would still email people links that go nowhere.
     */
    expect(configure().options.basePath).toBe('/v1/dashboard/auth');
    expect(configure({ basePath: '/somewhere/else/auth' }).options.basePath).toBe(
      '/somewhere/else/auth',
    );
  });
});

describe('rate limiting', () => {
  it('is enabled explicitly, never inherited from NODE_ENV', () => {
    /*
     * A bug fix, not a tuning choice. Better Auth resolves
     * `enabled: options.rateLimit?.enabled ?? isProduction`, and its
     * `isProduction` is `NODE_ENV === 'production'` with a default of
     * `'development'` — while **AWS Lambda does not set `NODE_ENV`**. Left at
     * the default, every auth endpoint in production would have been unlimited
     * and nothing about the deployment would have looked wrong.
     */
    expect(configure().options.rateLimit?.enabled).toBe(true);
  });

  it('limits password reset harder than sign-in', () => {
    // Reset is tighter because each success spends an email against the
    // 100/day Resend cap (P0-64) — the limit protects a budget as well as an
    // account. An unlimited reset endpoint is also an enumeration oracle.
    const rules = configure().options.rateLimit?.customRules ?? {};
    const perMinute = (rule?: { window: number; max: number }): number =>
      rule === undefined ? Infinity : (rule.max / rule.window) * 60;

    expect(perMinute(rules['/request-password-reset'])).toBeLessThan(
      perMinute(rules['/sign-in/email']),
    );
  });

  it('names the paths as Better Auth sees them, with basePath stripped', () => {
    // A rule keyed `/v1/dashboard/auth/sign-in/email` would match nothing and
    // silently leave that endpoint on the default limit.
    for (const path of Object.keys(configure().options.rateLimit?.customRules ?? {})) {
      expect(path.startsWith('/v1/')).toBe(false);
    }
  });
});

describe('client IP resolution', () => {
  it('is configured, because the fallback is a single shared bucket', () => {
    /*
     * The consequence is not what it sounds like. When `getIP` cannot resolve
     * an address it does not disable limiting — it puts every caller in one
     * bucket per path, so one attacker exhausting the sign-in limit locks out
     * **every** user. A limiter that cannot tell callers apart is a denial of
     * service wearing a protection's clothes.
     */
    expect(configure().options.advanced?.ipAddress?.ipAddressHeaders).toEqual(['x-forwarded-for']);
  });
});

describe('the twoFactor plugin', () => {
  it('is registered, so its tables are live from the start', () => {
    // P0-23a created `auth_two_factor` up front on purpose: adding it later is
    // a data migration against a table holding secrets, which is the least
    // pleasant kind. Registering the plugin now is the other half of that.
    expect(configure().options.plugins?.map((plugin) => plugin.id)).toContain('two-factor');
  });
});

describe('createAuth', () => {
  it('exposes exactly the two members the application is allowed to use', () => {
    /*
     * The narrowing is deliberate. Nothing outside `auth.ts` should depend on
     * Better Auth's shape — it keeps a library swap to one file, and it lets
     * `apps/api` hand its own tests a fake with no database. It is also load
     * bearing for the build: the fully inferred type reaches into zod's
     * internals, which pnpm's isolated `node_modules` makes unnameable, and
     * declaration emit fails outright with TS2742.
     */
    const auth = createAuth(options);

    expect(typeof auth.handler).toBe('function');
    expect(typeof auth.api.getSession).toBe('function');
  });

  it('is a factory, so importing this module connects to nothing', () => {
    /*
     * The plan sketched a module-level `auth` object. That would build the
     * drizzle adapter at import time, so merely importing this module from the
     * worker — or from a test — opens a client, and it would bake in a
     * `sendResetPassword` no call site can see.
     */
    expect(createAuth(options)).not.toBe(createAuth(options));
  });
});
