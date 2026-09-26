import { audit, ConflictError, NotFoundError } from '@catalogorosso/core';
import {
  insertKeys,
  readActiveKeys,
  replaceSecretKey,
  withTenant,
  type ActiveKeys,
} from '@catalogorosso/db';
import {
  hashSecretKey,
  newPublicKey,
  newSecretKey,
  secretKeyHint,
} from '@catalogorosso/security/api-keys';

/**
 * The keys port (P4-09, ADR 0025).
 *
 * **A secret key exists in plaintext for exactly as long as this function is
 * running.** It is generated here, hashed here, handed back once in the
 * response, and nowhere else: not to the statements, which take the hash; not
 * to the audit row, which records that a key changed and never what it is; not
 * to a log, which the redaction would scrub anyway but which should never be
 * asked to.
 */

/** What the dashboard shows. There is no path that returns the secret twice. */
export interface KeysView {
  readonly publicKey: string;
  readonly secretKeyPrefix: string;
  readonly secretKeyLast4: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The one response that ever carries a secret key. */
export interface IssuedKeys extends KeysView {
  /**
   * The plaintext, **this once**. The seller is told before they ask that it
   * cannot be shown again — the route documents it and the dashboard says it
   * above the button — because "I didn't copy it" has only one remedy, and it
   * is rotating.
   */
  readonly secretKey: string;
}

export interface KeysPort {
  read(tenantId: string): Promise<KeysView>;
  create(tenantId: string): Promise<IssuedKeys>;
  rotateSecret(tenantId: string): Promise<IssuedKeys>;
}

const view = (keys: ActiveKeys): KeysView => ({
  publicKey: keys.publicKey,
  secretKeyPrefix: keys.secretKeyPrefix,
  secretKeyLast4: keys.secretKeyLast4,
  createdAt: keys.createdAt.toISOString(),
  updatedAt: keys.updatedAt.toISOString(),
});

/** A fresh secret, in the three forms the rest of this file needs. */
const freshSecret = (
  generate: () => string,
): {
  readonly plaintext: string;
  readonly hash: string;
  readonly prefix: string;
  readonly last4: string;
} => {
  const plaintext = generate();
  const { prefix, last4 } = secretKeyHint(plaintext);

  return { plaintext, hash: hashSecretKey(plaintext), prefix, last4 };
};

export interface KeysDeps {
  /** Injected for the reason `members.ts` gives: it makes the audit row assertable. */
  readonly audit?: typeof audit;
  /** Injected so a test can assert what was stored against what was returned. */
  readonly newSecret?: () => string;
  readonly newPublic?: () => string;
}

export const createKeysPort = ({
  audit: record = audit,
  newSecret = newSecretKey,
  newPublic = newPublicKey,
}: KeysDeps = {}): KeysPort => ({
  async read(tenantId) {
    const keys = await withTenant(tenantId, (tx) => readActiveKeys(tx));

    if (keys === undefined) throw new NotFoundError('No keys have been issued yet.');

    return view(keys);
  },

  async create(tenantId) {
    const secret = freshSecret(newSecret);

    const created = await withTenant(tenantId, async (tx) => {
      const inserted = await insertKeys(tx, {
        publicKey: newPublic(),
        secretKeyHash: secret.hash,
        secretKeyPrefix: secret.prefix,
        secretKeyLast4: secret.last4,
      });

      /*
       * **What was issued, never the key.** The prefix and last four are what
       * identify it later — "which key was live when this happened?" — and
       * neither is enough to use it. `metadata` goes through the redaction
       * allowlist regardless (P0-56), which is a second line rather than the
       * first: the first is not handing it the secret at all.
       */
      if (inserted !== undefined) {
        await record(tx, {
          action: 'keys.created',
          target: inserted.publicKey,
          metadata: { secretKeyPrefix: secret.prefix, secretKeyLast4: secret.last4 },
        });
      }

      return inserted;
    });

    /*
     * A pair already exists, so this click lost the race or was a second one.
     * Refused rather than replaced: replacing would silently invalidate a secret
     * key the seller may already have deployed, and hand them one they did not
     * ask for.
     */
    if (created === undefined) {
      throw new ConflictError(
        'This winery already has keys. To replace the secret key, rotate it instead.',
      );
    }

    return { ...view(created), secretKey: secret.plaintext };
  },

  async rotateSecret(tenantId) {
    const secret = freshSecret(newSecret);

    const rotated = await withTenant(tenantId, async (tx) => {
      const updated = await replaceSecretKey(tx, {
        secretKeyHash: secret.hash,
        secretKeyPrefix: secret.prefix,
        secretKeyLast4: secret.last4,
      });

      if (updated !== undefined) {
        await record(tx, {
          action: 'keys.secret_rotated',
          target: updated.publicKey,
          metadata: { secretKeyPrefix: secret.prefix, secretKeyLast4: secret.last4 },
        });
      }

      return updated;
    });

    if (rotated === undefined) {
      throw new NotFoundError('No keys have been issued yet, so there is nothing to rotate.');
    }

    return { ...view(rotated), secretKey: secret.plaintext };
  },
});

export class KeysPortNotConfiguredError extends Error {
  constructor() {
    super(
      'No keys port was supplied to createApp, so keys cannot be issued. This is a wiring ' +
        'bug at the composition root, not a request problem.',
    );
    this.name = 'KeysPortNotConfiguredError';
  }
}

export const unconfiguredKeys: KeysPort = {
  read: () => Promise.reject(new KeysPortNotConfiguredError()),
  create: () => Promise.reject(new KeysPortNotConfiguredError()),
  rotateSecret: () => Promise.reject(new KeysPortNotConfiguredError()),
};
