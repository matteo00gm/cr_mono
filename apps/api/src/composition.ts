import {
  betterAuthRateLimitStorage,
  chooseTransport,
  createAuth,
  createSendEmail,
  logTransport,
  resendTransport,
  type MembershipReader,
  type ResetPasswordEmail,
  type SuppressionCheck,
} from '@catalogorosso/core';
import type { RateLimiter } from '@catalogorosso/security';
import { isSuppressed, readMembershipsForUser, withUser } from '@catalogorosso/db';

import { createMembersPort, type MembersPort } from './members.js';
import type { AuthPort } from './middleware/auth.js';
import { AUTH_PUBLIC_PATH } from './routes.js';

/**
 * What the entry point assembles, extracted so it can be asserted (E9).
 *
 * **The extraction is most of the fix.** `index.ts` used to do this work at
 * module scope and threw on import without `AUTH_SECRET`, so no test could look
 * at it — and none did. P0-64 and P0-51 were each verified against their own
 * seam, with a fake transport and a fake port, and both suites were green while
 * the real entry point wired neither: password reset sent nothing, and the
 * invite endpoints answered 500 through the fail-loud default that was written
 * to catch exactly this and had quietly become the implementation.
 *
 * A green suite that says nothing about the one place the real dependencies
 * meet is the shape of failure worth naming here, because every individual
 * piece looks correct in isolation and is.
 */

/**
 * Better Auth's reset-token lifetime, in minutes.
 *
 * Stated here because the *email* quotes it to the reader, and a number in the
 * message that disagrees with the one enforced is worse than no number: it
 * teaches people the link lasts longer than it does.
 */
const RESET_EXPIRY_MINUTES = 60;

export interface RuntimeConfig {
  /** Signs cookies and tokens. From SSM in a deployment (P0-15). */
  readonly authSecret: string;
  /** The origin Better Auth builds callback and reset URLs against. */
  readonly authBaseUrl: string;
  /**
   * The deployment stage.
   *
   * Load-bearing for email: `chooseTransport` sends through the provider only
   * when this is exactly `production` and routes everything else to the log. A
   * typo here does not open a hole, it closes one — mail that should have been
   * sent is logged instead, which is the safe direction for a value this
   * important.
   */
  readonly stage: string;
  /** `Sommelier <noreply@…>`; the domain must be the authenticated one (E6). */
  readonly emailFrom: string;
  /**
   * Absent until the sending domain is authenticated (E6), and that must not
   * stop the container starting: an API that refuses to boot for want of an
   * email key is a worse outage than one that logs its mail.
   */
  readonly resendApiKey?: string | undefined;
  /** Addresses that may receive real mail from a non-production stage. */
  readonly emailAllowlist?: readonly string[] | undefined;
  /** Where an invitee lands. The token is appended as the last path segment. */
  readonly acceptUrlBase?: string | undefined;
  /** Injected so a test can read what the log transport wrote. */
  readonly log?: ((line: string) => void) | undefined;
  /** Raised when a message is finally abandoned, for the P0-64 alarm. */
  readonly onEmailFailure?: ((failure: { readonly to: string }) => void) | undefined;
  /**
   * How the suppression list is read on the reset path.
   *
   * A port for the reason every other port here exists (P0-09): the default
   * opens a real transaction, so without this the one test that asserts the
   * reset wiring would need a container to check a string. Production never
   * passes it.
   */
  readonly suppression?: ((userId: string) => SuppressionCheck) | undefined;
  /**
   * The shared secret CloudFront attaches to origin requests (A2).
   *
   * Absent is permitted only where there is no CloudFront in front — a local
   * run, or the suite. `buildDependencies` does not police that; `index.ts`
   * does, because it is the only place that knows whether this is a deployment.
   */
  readonly originSecret?: string | undefined;
  /**
   * Where auth rate-limit counters live (A1).
   *
   * Absent means Better Auth's own in-memory store, which in Lambda counts
   * **per container**: N warm containers give an attacker N times each
   * configured limit, and a recycle resets the counter to zero. Correct for a
   * local run and the suite; never for a deployment, which `index.ts` enforces.
   *
   * A port rather than a construction here, for the reason every port in this
   * file exists: the default opens a database transaction, so a test asserting
   * the wiring would otherwise need a container to check a string.
   */
  readonly rateLimiter?: RateLimiter | undefined;
}

export interface Dependencies {
  readonly auth: AuthPort;
  /** Passed through to `createApp`; absent means the guard is not installed. */
  readonly originSecret?: string | undefined;
  readonly readMemberships: MembershipReader;
  readonly members: MembersPort;
  /** Exposed so the wiring is assertable, not because anything else calls it. */
  readonly sendResetPassword: (email: ResetPasswordEmail) => Promise<void>;
}

/**
 * Reads the suppression list on a path that has no tenant.
 *
 * `withUser` rather than an un-scoped connection, and the choice is the point.
 * `email_suppressions` carries no `tenant_id` and no policy, so *any* connection
 * could read it — but "any connection" is precisely what this repository does
 * not hand out (P0-19). `withUser` is the narrowest sanctioned context available
 * on a password-reset path, where the user is known and the tenant is not and
 * never will be. It costs one short transaction and adds no new escape hatch,
 * which is worth more than the round trip it saves.
 */
const suppressionForUser = (userId: string): SuppressionCheck => ({
  isSuppressed: (address) => withUser(userId, (tx) => isSuppressed(tx, address)),
});

export const buildDependencies = (config: RuntimeConfig): Dependencies => {
  const log = logTransport(config.log);

  /*
   * The provider is built only when there is a key. Without one the log
   * transport stands in on every stage, which is correct rather than degraded:
   * the sending domain is not authenticated yet (E6), so a real send would be
   * rejected anyway — and rejected *after* spending a request, where the log is
   * immediate and readable.
   */
  const provider =
    config.resendApiKey === undefined
      ? log
      : resendTransport({ apiKey: config.resendApiKey, fetch: globalThis.fetch });

  const transport = chooseTransport({
    stage: config.stage,
    provider,
    log,
    allowlist: config.emailAllowlist,
  });

  const sendEmailWith = (suppression: SuppressionCheck) =>
    createSendEmail({
      transport,
      from: config.emailFrom,
      suppression,
      onFailure: config.onEmailFailure,
    });

  const suppressionFor = config.suppression ?? suppressionForUser;

  /**
   * The real reset sender, replacing the placeholder that logged and resolved.
   *
   * It still **resolves rather than throwing on a suppressed address**, and
   * that inherits the placeholder's reasoning rather than repeating it by
   * accident: Better Auth calls this only when the address belongs to a real
   * user, so a sender that threw would make reset 500 for real addresses and
   * 200 for invented ones — an account-enumeration oracle manufactured by the
   * error path, and exactly what P0-46's enumeration group exists to prevent.
   * `sendEmail` returns a `suppressed` outcome rather than throwing, for
   * callers shaped like this one.
   */
  const sendResetPassword = async (email: ResetPasswordEmail): Promise<void> => {
    await sendEmailWith(suppressionFor(email.userId))({
      to: email.to,
      template: 'password-reset',
      props: { resetUrl: email.url, expiresInMinutes: RESET_EXPIRY_MINUTES },
    });
  };

  return {
    auth: createAuth({
      secret: config.authSecret,
      baseUrl: config.authBaseUrl,

      /*
       * Present only when a limiter was supplied. Passing `undefined` is
       * equivalent to omitting it, but writing it conditionally keeps the
       * intent visible: without one this is deliberately the library's
       * per-container default, and that is `index.ts`'s decision to allow.
       */
      ...(config.rateLimiter === undefined
        ? {}
        : { rateLimitStorage: betterAuthRateLimitStorage(config.rateLimiter) }),

      /*
       * The *mounted* path, not `/auth`. Better Auth is handed the raw
       * `Request`, whose URL carries the whole path, and it builds reset and
       * callback URLs from `baseUrl + basePath` — so the sub-app-relative
       * prefix would both fail to match and email people links going nowhere.
       */
      basePath: AUTH_PUBLIC_PATH,
      sendResetPassword,
    }),

    readMemberships: readMembershipsForUser,

    ...(config.originSecret === undefined ? {} : { originSecret: config.originSecret }),

    /*
     * The invite path checks the suppression list inside the transaction it
     * already holds (see `members.ts`), which is both cheaper and better —
     * an invitation for an undeliverable address is never created at all. So
     * the seam's own check has nothing left to do on that path, and passing a
     * no-op says so rather than opening a second connection to ask a question
     * already answered.
     */
    members: createMembersPort({
      sendEmail: sendEmailWith({ isSuppressed: () => Promise.resolve(false) }),
      acceptUrlBase: config.acceptUrlBase ?? `${config.authBaseUrl}/invito`,
    }),

    sendResetPassword,
  };
};
