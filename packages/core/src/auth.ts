import { authSchema, getAuthDb } from '@catalogorosso/db/auth';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins/two-factor';

/**
 * Better Auth configuration (P0-45).
 *
 * The dashboard's entire authentication boundary, and — unlike with a hosted
 * IdP — ours to get right. The plan lists what that now means and each item is
 * a thing to configure and test rather than assume: password hashing and
 * reset-token handling, account enumeration including timing, rate limits on
 * `/auth/*`, session fixation and revocation, TOTP correctness, and keeping the
 * library patched, since it is now in the security-critical path.
 *
 * **This module is the single file permitted to reach the database without
 * `withTenant`.** See `packages/db/src/auth-db.ts` for why the exception exists
 * and what stops it spreading; the P0-09 rule names this path explicitly, so a
 * second consumer is a boundary violation rather than a review comment.
 *
 * A factory rather than a module-level `auth` object, for two reasons. The
 * exported singleton in the plan's sketch would open a database connection at
 * import time — so merely importing this module from a test, or from the worker,
 * connects — and it would bake in a `sendResetPassword` that no call site can
 * see. Both are the kind of thing that is invisible until it is a problem.
 */

/**
 * The seam P0-64 fills in.
 *
 * Required rather than defaulted, deliberately. A default that quietly did
 * nothing would ship a password-reset flow that returns success and sends no
 * email — and because the reset response is identical whether or not the
 * address exists (P0-46's enumeration requirement), *nothing about the
 * behaviour would look wrong*. Making it a required argument moves the decision
 * to the composition root, where it is visible.
 */
export interface ResetPasswordEmail {
  readonly to: string;
  /** The single-use reset link, already carrying the token. */
  readonly url: string;
  readonly token: string;
}

export interface AuthOptions {
  /** Signs cookies and tokens. From SSM in a deployment (P0-15). */
  readonly secret: string;
  /** The origin Better Auth builds callback and reset URLs against. */
  readonly baseUrl: string;
  /** Origins allowed to present a session cookie. The dashboard, and no more. */
  readonly trustedOrigins?: readonly string[];
  /**
   * The **full public path** Better Auth is reachable at, e.g.
   * `/v1/dashboard/auth`.
   *
   * Not the sub-app-relative prefix, and the difference is not cosmetic. The
   * handler is given the raw `Request`, whose URL carries the whole path — so a
   * `basePath` of `/auth` matches nothing once the app is mounted under
   * `/v1/dashboard`, and every auth endpoint 404s. Better Auth also builds
   * callback and password-reset URLs from `baseUrl + basePath`, so a value that
   * is merely route-correct would still email people a broken link.
   *
   * Supplied by the caller rather than defaulted here, because where the app is
   * mounted is `apps/api`'s knowledge and this package has no business
   * asserting it.
   */
  readonly basePath: string;
  readonly sendResetPassword: (email: ResetPasswordEmail) => Promise<void>;
}

/**
 * How long a cached session may outlive a revocation, in seconds.
 *
 * Named and exported because it is a *trade*, not a constant: the cookie cache
 * makes the common read cheap by trusting a signed copy for this long, which
 * means an OWNER removing somebody has up to this long before it takes effect
 * on a cached read. Five minutes is the plan's figure. P0-46 asserts the bound
 * rather than the behaviour, so the cost of the trade stays measured, and
 * P4-11's step-up check reads the database directly to bypass it entirely.
 */
export const SESSION_COOKIE_CACHE_SECONDS = 300;

/**
 * What the rest of the system may use, and no more.
 *
 * A hand-written interface rather than `ReturnType<typeof betterAuth>`, for one
 * practical reason and one design one.
 *
 * The practical one: `betterAuth` is generic over the exact options object it
 * is given, so the inferred type is enormous and reaches into zod's internals.
 * Under pnpm's isolated `node_modules` that path is not nameable from this
 * package, and declaration emit fails outright with TS2742 — a real error, not
 * a warning, and not fixable by adding zod as a dependency.
 *
 * The design one, which is why this is the right fix rather than a workaround:
 * **nothing outside this file should depend on Better Auth's shape.** Two
 * members are all the application uses — the fetch handler, and one session
 * read. Narrowing here means swapping the library later is a change to one
 * file, and it means `apps/api` can hand a fake to its own tests without a
 * database. `apps/api/src/middleware/auth.ts` declares the same two members as
 * its port, and this satisfies it structurally.
 *
 * The plugin endpoints (`api.enableTwoFactor` and the rest) are deliberately
 * not here: they are reached over HTTP through `handler`, and P4-11 can widen
 * this if it ever needs to call one directly.
 */
export interface AuthInstance {
  /** Better Auth's Fetch-API handler, mounted at `/auth/*` on the dashboard. */
  readonly handler: (request: Request) => Promise<Response>;
  readonly api: {
    readonly getSession: (input: {
      headers: Headers;
    }) => Promise<{ user: { id: string; email: string } } | null>;
  };
}

export const createAuth = (options: AuthOptions): AuthInstance =>
  betterAuth({
    secret: options.secret,
    baseURL: options.baseUrl,
    basePath: options.basePath,
    ...(options.trustedOrigins === undefined
      ? {}
      : { trustedOrigins: [...options.trustedOrigins] }),

    /**
     * Our table names, not Better Auth's defaults.
     *
     * `user` is a reserved word in Postgres (P0-23a), so every table carries
     * the `auth_` prefix. The drizzle adapter resolves `schema[model]` by the
     * *configured* model name, so these strings and the keys in `authSchema`
     * have to match exactly — a mismatch throws at the first query rather than
     * at startup, which is a worse place to find out.
     */
    user: { modelName: 'auth_users' },
    account: { modelName: 'auth_accounts' },
    verification: { modelName: 'auth_verifications' },

    session: {
      modelName: 'auth_sessions',

      /**
       * The cookie cache, and the reason sessions live in Postgres at all.
       *
       * A JWT that cannot be revoked stays valid after an OWNER removes
       * somebody, so the session of record is a row. The cache keeps the common
       * read cheap by trusting a signed copy for a short TTL — see the constant
       * above for what that costs and who pays it.
       */
      cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_SECONDS },
    },

    database: drizzleAdapter(getAuthDb(), { provider: 'pg', schema: authSchema }),

    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url, token }) => {
        await options.sendResetPassword({ to: user.email, url, token });
      },
    },

    advanced: {
      /**
       * `Secure`, `HttpOnly` and `SameSite=Lax` on every auth cookie.
       *
       * `HttpOnly` is Better Auth's default and is restated here so that all
       * three appear together — the set is the property, and a reader checking
       * "are the cookie flags right" should not have to know which of them came
       * from a default. `Lax` rather than `Strict` because `Strict` drops the
       * cookie on any cross-site navigation *into* the dashboard, including a
       * link from a password-reset email.
       */
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: true },
    },

    plugins: [
      twoFactor({
        issuer: 'Sommelier AI',
        // Matches P0-23a's table. Without it the plugin looks for `twoFactor`
        // and the adapter throws on the first enrolment.
        twoFactorTable: 'auth_two_factor',
      }),
    ],
  });
