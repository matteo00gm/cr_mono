import { describe, expect, it } from 'vitest';

import {
  backupCodeStorage,
  createMfaRules,
  hashBackupCode,
  hashTotpCode,
  mfaHardening,
  STEP_UP_MAX_AGE_SECONDS,
  STEP_UP_REQUIRED_CODE,
  TOTP_CLAIM_SECONDS,
  TWO_FACTOR_PATHS,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW_STEPS,
} from '../src/auth-mfa.js';

/**
 * The pieces of the MFA hardening that are pure (P4-11).
 *
 * What the hooks do to Better Auth's real endpoints is asserted against the real
 * library in `apps/api/test/mfa.integration.test.ts`; these pin the arithmetic
 * and the storage format, where a wrong value would be silent there.
 */

const SECRET = 'unit-suite-secret-not-used-to-sign-anything-real';

describe('the numbers', () => {
  it('keeps a spent code spent for every step the plugin would accept it in', () => {
    /* ±1 step: the one before, the one now, the one after. Shorter reopens a replay. */
    expect(TOTP_CLAIM_SECONDS).toBe(TOTP_PERIOD_SECONDS * (2 * TOTP_WINDOW_STEPS + 1));
    expect(TOTP_CLAIM_SECONDS).toBe(90);
  });

  it('keeps a verification fresh for fifteen minutes, the row figure', () => {
    expect(STEP_UP_MAX_AGE_SECONDS).toBe(900);
  });
});

describe('a stored backup code', () => {
  const storage = backupCodeStorage(SECRET);

  it('is an HMAC of the code, never the code', async () => {
    const stored = JSON.parse(await storage.encrypt(JSON.stringify(['ab12c-de34f']))) as string[];

    expect(stored).toEqual([hashBackupCode(SECRET, 'ab12c-de34f')]);
    expect(stored[0]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('stays a hash when the remaining codes are written back after one is spent', async () => {
    /* The plugin re-encodes what is left, which by then is hashes. */
    const once = await storage.encrypt(JSON.stringify(['ab12c-de34f', 'zz99y-xx88w']));
    const twice = await storage.encrypt(once);

    expect(twice).toBe(once);
  });

  it('is handed back as stored, for the plugin to compare with a hashed attempt', async () => {
    const stored = await storage.encrypt(JSON.stringify(['ab12c-de34f']));

    await expect(storage.decrypt(stored)).resolves.toBe(stored);
  });

  it('refuses anything that is not a list, rather than storing it', async () => {
    await expect(storage.encrypt(JSON.stringify({ code: 'x' }))).rejects.toThrow(TypeError);
  });

  it('depends on the secret, so a database alone is not a lookup table', () => {
    expect(hashBackupCode(SECRET, 'ab12c-de34f')).not.toBe(
      hashBackupCode(`${SECRET}-other`, 'ab12c-de34f'),
    );
  });
});

describe('a spent TOTP code', () => {
  it('is remembered by a keyed hash that no backup code shares', () => {
    /* Separate purposes, so one kind of value can never stand in for the other. */
    expect(hashTotpCode(SECRET, '123456')).not.toBe(hashBackupCode(SECRET, '123456'));
    expect(hashTotpCode(SECRET, '123456')).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('the hooks', () => {
  const plugin = mfaHardening({
    secret: SECRET,
    store: {
      claimTotpCode: () => Promise.resolve(true),
      isLocked: () => Promise.resolve(false),
      recordFailure: () => Promise.resolve(),
      clearFailures: () => Promise.resolve(),
      markVerified: () => Promise.resolve(),
      stepUpState: () => Promise.resolve(undefined),
    },
  });

  const matches = (
    hooks: readonly { matcher: (ctx: { path?: string }) => boolean }[],
    path: string,
  ) => hooks.filter((hook) => hook.matcher({ path })).length;

  it.each(['/two-factor/verify-totp', '/two-factor/verify-backup-code'])(
    'watch %s before and after',
    (path) => {
      expect(matches(plugin.hooks.before, path)).toBe(1);
      expect(matches(plugin.hooks.after, path)).toBe(1);
    },
  );

  it.each([...TWO_FACTOR_PATHS.stepUp])('hold %s to a step-up, and record it', (path) => {
    expect(matches(plugin.hooks.before, path)).toBe(1);
    expect(matches(plugin.hooks.after, path)).toBe(1);
  });

  it('leave every other path alone', () => {
    for (const path of ['/sign-in/email', '/get-session', ...TWO_FACTOR_PATHS.unconfigured]) {
      expect(matches(plugin.hooks.before, path) + matches(plugin.hooks.after, path)).toBe(0);
    }
    expect(matches(plugin.hooks.before, undefined as unknown as string)).toBe(0);
  });
});

describe('the rules', () => {
  const USER = 'user_owner';
  const SESSION = 'session-token';

  interface State {
    readonly claimed?: boolean;
    readonly locked?: boolean;
    readonly enrolled?: boolean;
    readonly fresh?: boolean;
    readonly gone?: boolean;
  }

  /** A store that records every question it was asked, in order. */
  const rulesWith = (state: State = {}) => {
    const log: string[] = [];
    const changes: unknown[] = [];
    const rules = createMfaRules({
      secret: SECRET,
      store: {
        claimTotpCode: (userId, hash) => {
          log.push(`claim:${userId}:${hash}`);
          return Promise.resolve(state.claimed !== false);
        },
        isLocked: (userId) => {
          log.push(`locked?:${userId}`);
          return Promise.resolve(state.locked === true);
        },
        recordFailure: (userId) => {
          log.push(`fail:${userId}`);
          return Promise.resolve();
        },
        clearFailures: (userId) => {
          log.push(`clear:${userId}`);
          return Promise.resolve();
        },
        markVerified: (token) => {
          log.push(`verified:${token}`);
          return Promise.resolve();
        },
        stepUpState: (token) => {
          log.push(`state:${token}`);
          return Promise.resolve(
            state.gone === true
              ? undefined
              : {
                  userId: USER,
                  twoFactorEnabled: state.enrolled !== false,
                  fresh: state.fresh === true,
                },
          );
        },
      },
      onChange: (change) => {
        changes.push(change);
        return Promise.resolve();
      },
    });

    return { log, changes, rules };
  };

  const withSession = { userId: USER, sessionToken: SESSION };
  const signingIn = { userId: USER, sessionToken: undefined };
  const TOTP = '/two-factor/verify-totp';
  const BACKUP = '/two-factor/verify-backup-code';

  describe('before a code is checked', () => {
    it('claims a TOTP code under its keyed hash, for the user verifying', async () => {
      const { log, rules } = rulesWith();

      await expect(
        rules.beforeVerify(TOTP, { code: '123456' }, signingIn),
      ).resolves.toBeUndefined();
      expect(log).toEqual([`claim:${USER}:${hashTotpCode(SECRET, '123456')}`]);
    });

    it('refuses a code already claimed, as the plugin refuses a wrong one', async () => {
      const { rules } = rulesWith({ claimed: false });

      await expect(rules.beforeVerify(TOTP, { code: '123456' }, signingIn)).rejects.toMatchObject({
        statusCode: 401,
        body: { code: 'INVALID_CODE' },
      });
    });

    it('hashes a backup code in the body the plugin will compare, and claims nothing', async () => {
      const { log, rules } = rulesWith();

      const body = await rules.beforeVerify(
        BACKUP,
        { code: 'ab12c-de34f', trustDevice: false },
        signingIn,
      );

      expect(body).toEqual({ code: hashBackupCode(SECRET, 'ab12c-de34f'), trustDevice: false });
      expect(log).toEqual([]);
    });

    it('checks the budget with a session, before anything is claimed', async () => {
      const { log, rules } = rulesWith({ locked: true });

      await expect(rules.beforeVerify(TOTP, { code: '123456' }, withSession)).rejects.toMatchObject(
        {
          statusCode: 429,
          body: { code: 'ACCOUNT_TEMPORARILY_LOCKED' },
        },
      );
      expect(log).toEqual([`locked?:${USER}`]);
    });

    it('claims on the session path too, once the budget allows', async () => {
      const { log, rules } = rulesWith();

      await rules.beforeVerify(TOTP, { code: '123456' }, withSession);

      expect(log).toEqual([`locked?:${USER}`, `claim:${USER}:${hashTotpCode(SECRET, '123456')}`]);
    });

    it('leaves the sign-in budget to the plugin', async () => {
      const { log, rules } = rulesWith({ locked: true });

      await rules.beforeVerify(TOTP, { code: '123456' }, signingIn);

      expect(log).not.toContain(`locked?:${USER}`);
    });

    it('passes a body with no code through for the plugin to refuse', async () => {
      const { log, rules } = rulesWith();

      await expect(rules.beforeVerify(TOTP, { code: 42 }, signingIn)).resolves.toBeUndefined();
      await expect(rules.beforeVerify(TOTP, undefined, signingIn)).resolves.toBeUndefined();
      expect(log).toEqual([]);
    });
  });

  describe('after a code was checked', () => {
    it('stamps the session a sign-in created, and touches no budget', async () => {
      const { log, rules } = rulesWith();

      await rules.afterVerify(signingIn, { failed: false, issuedToken: 'new-session' });

      expect(log).toEqual(['verified:new-session']);
    });

    it("stamps the caller's own session on a step-up, and clears its budget", async () => {
      const { log, changes, rules } = rulesWith();

      await rules.afterVerify(withSession, { failed: false, issuedToken: undefined });

      expect(log).toEqual([`verified:${SESSION}`, `clear:${USER}`]);
      expect(changes).toEqual([]);
    });

    it('records an enrolment, which is a session coming back with a new one', async () => {
      const { log, changes, rules } = rulesWith();

      await rules.afterVerify(withSession, { failed: false, issuedToken: 'enrolled-session' });

      expect(log).toEqual(['verified:enrolled-session', `clear:${USER}`]);
      expect(changes).toEqual([{ userId: USER, event: 'enabled' }]);
    });

    it('counts a failure on the session path, and stamps nothing', async () => {
      const { log, rules } = rulesWith();

      await rules.afterVerify(withSession, { failed: true, issuedToken: undefined });

      expect(log).toEqual([`fail:${USER}`]);
    });

    it('leaves a failed sign-in to the plugin to count', async () => {
      const { log, rules } = rulesWith();

      await rules.afterVerify(signingIn, { failed: true, issuedToken: undefined });

      expect(log).toEqual([]);
    });

    it('stamps nothing when nothing was proved for any session', async () => {
      const { log, rules } = rulesWith();

      await rules.afterVerify(signingIn, { failed: false, issuedToken: undefined });

      expect(log).toEqual([]);
    });
  });

  describe('before a step-up path', () => {
    it('lets a fresh session through', async () => {
      const { rules } = rulesWith({ fresh: true });

      await expect(rules.beforeStepUp(SESSION)).resolves.toBeUndefined();
    });

    it('asks a stale one for a code', async () => {
      const { rules } = rulesWith({ fresh: false });

      await expect(rules.beforeStepUp(SESSION)).rejects.toMatchObject({
        statusCode: 403,
        body: { code: STEP_UP_REQUIRED_CODE },
      });
    });

    it('lets a first enrolment through, which has nothing to step up with', async () => {
      const { rules } = rulesWith({ enrolled: false, fresh: false });

      await expect(rules.beforeStepUp(SESSION)).resolves.toBeUndefined();
    });

    it('refuses a session the table no longer holds', async () => {
      const { rules } = rulesWith({ gone: true });

      await expect(rules.beforeStepUp(SESSION)).rejects.toMatchObject({
        statusCode: 401,
        body: { code: 'SESSION_EXPIRED' },
      });
    });

    it('leaves a request with no session to the endpoint, asking the store nothing', async () => {
      const { log, rules } = rulesWith();

      await expect(rules.beforeStepUp(undefined)).resolves.toBeUndefined();
      expect(log).toEqual([]);
    });
  });

  describe('after a step-up path', () => {
    it.each([
      ['/two-factor/disable', 'disabled'],
      ['/two-factor/generate-backup-codes', 'backup_codes_regenerated'],
      ['/two-factor/enable', 'replaced'],
    ])('records %s as %s for an enrolled account', async (path, event) => {
      const { changes, rules } = rulesWith();

      await rules.afterStepUp(path, { userId: USER, twoFactorEnabled: true });

      expect(changes).toEqual([{ userId: USER, event }]);
    });

    it('records nothing for a first enable, which a code has yet to prove', async () => {
      const { changes, rules } = rulesWith();

      await rules.afterStepUp('/two-factor/enable', { userId: USER, twoFactorEnabled: false });

      expect(changes).toEqual([]);
    });

    it('records nothing for reading the URI, which changes nothing', async () => {
      const { changes, rules } = rulesWith();

      await rules.afterStepUp('/two-factor/get-totp-uri', { userId: USER, twoFactorEnabled: true });

      expect(changes).toEqual([]);
    });
  });

  it('works with no audit callback at all', async () => {
    const rules = createMfaRules({
      secret: SECRET,
      store: {
        claimTotpCode: () => Promise.resolve(true),
        isLocked: () => Promise.resolve(false),
        recordFailure: () => Promise.resolve(),
        clearFailures: () => Promise.resolve(),
        markVerified: () => Promise.resolve(),
        stepUpState: () => Promise.resolve(undefined),
      },
    });

    await expect(
      rules.afterStepUp('/two-factor/disable', { userId: USER, twoFactorEnabled: true }),
    ).resolves.toBeUndefined();
    await expect(
      rules.afterVerify(withSession, { failed: false, issuedToken: 'enrolled-session' }),
    ).resolves.toBeUndefined();
  });
});
