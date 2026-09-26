import { createHmac } from 'node:crypto';

import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';

/**
 * What Better Auth's `twoFactor` plugin leaves for us to get right (P4-11,
 * ADR 0027).
 *
 * The plugin gives TOTP, backup codes and a sign-in lockout. Reading its source
 * (1.7.2) against the row turned up five places where it does less than the
 * row requires, and each is closed here, with its own test:
 *
 * 1. **Backup codes are stored encrypted, not hashed.** Encrypted means the
 *    server can read them back, and anybody holding the database and the auth
 *    secret can too. They are password-equivalent, so they are stored as HMACs
 *    and the code a caller sends is hashed before the plugin compares it.
 * 2. **A TOTP code is accepted as often as it is sent within its window.** The
 *    ±1-step window is right; the replay is not. A code is claimed before it is
 *    checked, and a second claim inside the window is refused.
 * 3. **With a session, verification has no attempt budget.** The lockout counts
 *    sign-in attempts only, so a stolen session cookie could guess step-up codes
 *    at whatever rate the path limit allows. The same budget applies here.
 * 4. **Re-enrolling replaces the secret on a password alone, and reading it
 *    out needs no more.** For somebody already enrolled, `/two-factor/enable`
 *    swaps in a new authenticator and `/two-factor/get-totp-uri` returns the
 *    live one — so a stolen session plus the password would take over the
 *    second factor, loudly or quietly. Both, and regenerating codes and
 *    disabling, are step-up actions.
 * 5. **Nothing records when a session last proved a second factor.** Every
 *    accepted code stamps `last_verified_at`, which is what step-up reads.
 *
 * The decisions are plain functions (`createMfaRules`) over a store, and the
 * hooks at the bottom are adapters from Better Auth's request context to them.
 * The plugin is pinned (P0-45), so what the library does with each answer is
 * asserted against its real behaviour in `mfa.integration.test.ts` — an upgrade
 * that changes a path or a hook contract fails there rather than quietly
 * reopening one of the five.
 */

/** How long a second factor stays fresh enough for a sensitive action. */
export const STEP_UP_MAX_AGE_SECONDS = 15 * 60;

/** The plugin's TOTP period and window, which `@better-auth/utils/otp` defaults to. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW_STEPS = 1;

/**
 * How long a spent code stays spent: the whole span in which the plugin would
 * accept it, which is the step before, the step itself and the step after.
 */
export const TOTP_CLAIM_SECONDS = TOTP_PERIOD_SECONDS * (2 * TOTP_WINDOW_STEPS + 1);

/**
 * The step-up budget, the plugin's own sign-in lockout figures. One budget for
 * both paths, as the plugin's is one across factors: an account is locked by
 * consecutive failures, wherever they came from.
 */
export const STEP_UP_MAX_FAILURES = 10;
export const STEP_UP_LOCK_SECONDS = 15 * 60;

/** Told to a caller whose session is too old for what it asked, in the plugin's own error shape. */
export const STEP_UP_REQUIRED_CODE = 'STEP_UP_REQUIRED';

/** What a sensitive action needs to know about the session asking. */
export interface StepUpState {
  readonly userId: string;
  readonly twoFactorEnabled: boolean;
  /** Whether a second factor was proved within `STEP_UP_MAX_AGE_SECONDS`. */
  readonly fresh: boolean;
}

/**
 * Where a spent code, a failure count and a session's freshness live.
 * Implemented in `packages/db/src/auth-db.ts`, the one file allowed the auth
 * adapter's connection (P0-45); this file only decides.
 *
 * **Every comparison with the clock is the database's.** `last_verified_at` is
 * stamped with `now()` and judged against `now()`, so a Lambda clock a second
 * behind Postgres cannot make a code proved a moment ago look like it was
 * proved in the future — and the answers are booleans, so no timestamp crosses
 * a raw `execute` as the string it arrives as.
 */
export interface MfaStore {
  /**
   * Records a code as spent for this user. `false` when it was already spent
   * inside the window — atomically, so two racing requests cannot both win.
   */
  readonly claimTotpCode: (userId: string, codeHash: string) => Promise<boolean>;
  readonly isLocked: (userId: string) => Promise<boolean>;
  readonly recordFailure: (userId: string) => Promise<void>;
  readonly clearFailures: (userId: string) => Promise<void>;
  /** Stamps the session's `last_verified_at`. */
  readonly markVerified: (sessionToken: string) => Promise<void>;
  /**
   * Read from the session row, never from the cookie cache — and `undefined`
   * for a session that has expired or been revoked, which a cached copy would
   * still vouch for.
   */
  readonly stepUpState: (sessionToken: string) => Promise<StepUpState | undefined>;
}

/**
 * A change to somebody's second factor, for the audit log (P4-11).
 *
 * `replaced` is its own event because it is the one an attacker would make: a
 * new authenticator on an account that already had one.
 */
export type TwoFactorEvent = 'enabled' | 'replaced' | 'backup_codes_regenerated' | 'disabled';

export interface TwoFactorChange {
  readonly userId: string;
  readonly event: TwoFactorEvent;
}

export interface MfaHardeningOptions {
  /** The auth secret, which keys every HMAC here. */
  readonly secret: string;
  readonly store: MfaStore;
  /** Every change to a second factor, for the audit log (P4-11). */
  readonly onChange?: ((change: TwoFactorChange) => Promise<void>) | undefined;
}

const hmac = (secret: string, purpose: string, value: string): string =>
  createHmac('sha256', secret).update(`${purpose}:${value}`).digest('hex');

/** A stored backup code: an HMAC, never the code. */
export const hashBackupCode = (secret: string, code: string): string =>
  hmac(secret, 'backup-code', code);

/** What a spent TOTP code is remembered as. */
export const hashTotpCode = (secret: string, code: string): string => hmac(secret, 'totp', code);

const STORED_HASH = /^[0-9a-f]{64}$/u;

/**
 * The plugin's `storeBackupCodes`, hashing instead of encrypting.
 *
 * `encrypt` is called with fresh codes when they are generated and with the
 * remaining *hashes* when one is spent, so it hashes what is not already a hash.
 * A generated code is `xxxxx-xxxxx`, which is never 64 hex characters, so the
 * two cannot be confused. `decrypt` hands back the hashes, and the plugin's
 * `includes` then compares them with the caller's code — which the before-hook
 * has already hashed.
 */
export const backupCodeStorage = (secret: string) => ({
  encrypt: (json: string): Promise<string> => {
    const codes = JSON.parse(json) as unknown;

    if (!Array.isArray(codes)) return Promise.reject(new TypeError('Backup codes must be a list.'));

    return Promise.resolve(
      JSON.stringify(
        codes.map((code) => {
          const text = String(code);
          return STORED_HASH.test(text) ? text : hashBackupCode(secret, text);
        }),
      ),
    );
  },
  decrypt: (stored: string): Promise<string> => Promise.resolve(stored),
});

/**
 * Every endpoint the `twoFactor` plugin mounts, each in exactly one class.
 *
 * **Exhaustive on purpose**, and a test holds it to the plugin's real endpoint
 * list: an upgrade that adds a path fails there until somebody decides which
 * class it belongs to, rather than serving it with none of the hardening.
 */
export const TWO_FACTOR_PATHS = {
  /** Where a code is proved: claimed, budgeted, and stamped on success. */
  verify: ['/two-factor/verify-totp', '/two-factor/verify-backup-code'],
  /**
   * Where the second factor is changed or read out. Each is a step-up action
   * for an account that already has one — a first enrolment has nothing to step
   * up with. `get-totp-uri` belongs here because it returns the *live* secret:
   * with a stolen session and the password, it copies the authenticator without
   * changing anything, which is quieter than replacing it.
   */
  stepUp: [
    '/two-factor/enable',
    '/two-factor/disable',
    '/two-factor/generate-backup-codes',
    '/two-factor/get-totp-uri',
  ],
  /**
   * The emailed-OTP method, which is not configured: `send-otp` refuses without
   * a sender and `verify-otp` has nothing to verify. Configuring it means
   * moving `verify-otp` into `verify`.
   */
  unconfigured: ['/two-factor/send-otp', '/two-factor/verify-otp'],
} as const;

const VERIFY_PATHS: ReadonlySet<string> = new Set(TWO_FACTOR_PATHS.verify);
const STEP_UP_PATHS: ReadonlySet<string> = new Set(TWO_FACTOR_PATHS.stepUp);

/** Who is verifying, and how: with a session (step-up, enrolment) or mid-sign-in. */
export interface Verifier {
  readonly userId: string;
  readonly sessionToken: string | undefined;
}

/** The plugin's own error body for a wrong code, so a replay answers exactly as one. */
const invalidCode = (): APIError =>
  new APIError('UNAUTHORIZED', { message: 'Invalid code', code: 'INVALID_CODE' });

/**
 * What a successful call to a step-up path changed. A first `enable` changes
 * nothing yet — the secret is not live until a code proves it, which is the
 * `enabled` event the verify hook records.
 */
const eventFor = (path: string, enrolled: boolean): TwoFactorEvent | undefined => {
  switch (path) {
    case '/two-factor/disable':
      return 'disabled';
    case '/two-factor/generate-backup-codes':
      return 'backup_codes_regenerated';
    case '/two-factor/enable':
      return enrolled ? 'replaced' : undefined;
    default:
      return undefined;
  }
};

const codeOf = (body: unknown): string | undefined => {
  const code = (body as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * The decisions, as plain functions over the store (P4-11).
 *
 * Separate from the hooks below so each rule is a unit test away: the hooks
 * adapt Better Auth's request context to these, and what the library then does
 * with the answer is asserted against the real thing in `mfa.integration`.
 */
export const createMfaRules = ({ secret, store, onChange }: MfaHardeningOptions) => ({
  /**
   * Before a code is checked. Throws to refuse; returns a replacement body when
   * the code the plugin compares must change, which is only ever a backup code.
   */
  beforeVerify: async (
    path: string,
    body: unknown,
    verifier: Verifier,
  ): Promise<Record<string, unknown> | undefined> => {
    /*
     * **The session path's budget** (3). Mid-sign-in the plugin keeps its own;
     * with a session it keeps none, so this is the only one.
     */
    if (verifier.sessionToken !== undefined && (await store.isLocked(verifier.userId))) {
      throw new APIError('TOO_MANY_REQUESTS', {
        message:
          'Too many failed verification attempts. Your account is temporarily locked. ' +
          'Please try again later.',
        code: 'ACCOUNT_TEMPORARILY_LOCKED',
      });
    }

    const code = codeOf(body);

    if (code === undefined) return undefined;

    /* (1) The plugin compares what it is given with what it stored. */
    if (path === '/two-factor/verify-backup-code') {
      return { ...(body as Record<string, unknown>), code: hashBackupCode(secret, code) };
    }

    /*
     * (2) **Claimed before it is checked.** A wrong code is claimed too, which
     * costs nothing — it was wrong — and means the refusal for a replayed code
     * is the refusal for a wrong one, so a replay learns nothing about whether
     * the code it stole was ever good.
     */
    if (!(await store.claimTotpCode(verifier.userId, hashTotpCode(secret, code)))) {
      throw invalidCode();
    }

    return undefined;
  },

  /**
   * After a code was checked. `issuedToken` is the session the plugin created,
   * when it created one: a sign-in, or an enrolment.
   */
  afterVerify: async (
    verifier: Verifier,
    { failed, issuedToken }: { readonly failed: boolean; readonly issuedToken: string | undefined },
  ): Promise<void> => {
    if (failed) {
      /* The plugin counts sign-in failures itself; these are the session path's. */
      if (verifier.sessionToken !== undefined) await store.recordFailure(verifier.userId);
      return;
    }

    /*
     * (5) A new session is a sign-in or an enrolment, and the code was just
     * proved for it; otherwise the caller's own session stepped up.
     */
    const verified = issuedToken ?? verifier.sessionToken;

    if (verified !== undefined) await store.markVerified(verified);

    if (verifier.sessionToken === undefined) return;

    await store.clearFailures(verifier.userId);

    /* A session that verified and came back with a new one just enrolled. */
    if (issuedToken !== undefined) await onChange?.({ userId: verifier.userId, event: 'enabled' });
  },

  /** (4) Before a step-up path. Identity may come from the cache; freshness never does. */
  beforeStepUp: async (sessionToken: string | undefined): Promise<void> => {
    /* No session: the endpoint's own session check refuses. */
    if (sessionToken === undefined) return;

    const state = await store.stepUpState(sessionToken);

    /*
     * Gone from the table while a cached copy still vouches for it: a revoked
     * session. Refused, never waved through to an endpoint whose own session
     * check may read the same cache.
     */
    if (state === undefined) {
      throw new APIError('UNAUTHORIZED', {
        message: 'Your session has ended. Sign in again.',
        code: 'SESSION_EXPIRED',
      });
    }

    /* A first enrolment has nothing to step up with. */
    if (!state.twoFactorEnabled) return;

    if (!state.fresh) {
      throw new APIError('FORBIDDEN', {
        message: 'Enter a code from your authenticator app to change two-factor settings.',
        code: STEP_UP_REQUIRED_CODE,
      });
    }
  },

  /** After a step-up path succeeded: what it changed, for the audit log. */
  afterStepUp: async (
    path: string,
    session: { readonly userId: string; readonly twoFactorEnabled: boolean },
  ): Promise<void> => {
    const event = eventFor(path, session.twoFactorEnabled);

    if (event !== undefined) await onChange?.({ userId: session.userId, event });
  },
});

/* ---- the adapters -------------------------------------------------------- */

/**
 * Per-request state, from the before-hook to the after-hook.
 *
 * Keyed on Better Auth's per-request context object, which both hooks see. A
 * missing entry in the after-hook marks nothing — the fail-safe direction: the
 * next sensitive action asks for a code again.
 */
const verifiers = new WeakMap<object, Verifier>();

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * Who is verifying. With a session, the session's user; mid-sign-in, the user
 * the plugin's signed `two_factor` cookie names — resolved the way the plugin
 * resolves it, so a claim is made for the same user the code is checked against.
 */
const verifierOf = async (ctx: HookContext): Promise<Verifier | undefined> => {
  const session = await getSessionFromCtx(ctx);

  if (session) return { userId: session.user.id, sessionToken: session.session.token };

  const cookie = ctx.context.createAuthCookie('two_factor');
  const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  const verification =
    typeof signed === 'string' && signed !== ''
      ? await ctx.context.internalAdapter.findVerificationValue(signed)
      : null;

  return verification ? { userId: verification.value, sessionToken: undefined } : undefined;
};

const failedOf = (returned: unknown): boolean => isAPIError(returned) || returned instanceof Error;

const on =
  (paths: ReadonlySet<string>) =>
  (ctx: { path?: string }): boolean =>
    ctx.path !== undefined && paths.has(ctx.path);

export const mfaHardening = (options: MfaHardeningOptions) => {
  const rules = createMfaRules(options);

  return {
    id: 'mfa-hardening',
    hooks: {
      before: [
        {
          matcher: on(VERIFY_PATHS),
          handler: createAuthMiddleware(async (ctx) => {
            const verifier = await verifierOf(ctx);

            /* No user to hold to anything: the plugin refuses this itself. */
            if (verifier === undefined) return;

            verifiers.set(ctx.context, verifier);

            const body = await rules.beforeVerify(ctx.path, ctx.body, verifier);

            return body === undefined ? undefined : { context: { body } };
          }),
        },
        {
          matcher: on(STEP_UP_PATHS),
          handler: createAuthMiddleware(async (ctx) => {
            await rules.beforeStepUp((await getSessionFromCtx(ctx))?.session.token);
          }),
        },
      ],
      after: [
        {
          matcher: on(VERIFY_PATHS),
          handler: createAuthMiddleware(async (ctx) => {
            const verifier = verifiers.get(ctx.context);

            if (verifier === undefined) return;

            verifiers.delete(ctx.context);

            await rules.afterVerify(verifier, {
              failed: failedOf(ctx.context.returned),
              issuedToken: ctx.context.newSession?.session.token,
            });
          }),
        },
        {
          matcher: on(STEP_UP_PATHS),
          handler: createAuthMiddleware(async (ctx) => {
            /* The session as the request began: `enable` changes nothing on it until verified. */
            const session = failedOf(ctx.context.returned) ? null : await getSessionFromCtx(ctx);

            if (!session) return;

            await rules.afterStepUp(ctx.path, {
              userId: session.user.id,
              twoFactorEnabled:
                (session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled === true,
            });
          }),
        },
      ],
    },
  };
};
