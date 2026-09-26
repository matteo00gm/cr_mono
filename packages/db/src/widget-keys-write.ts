import { sql } from 'drizzle-orm';

import { asDate, type SqlTimestamp } from './timestamps.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * Creating and rotating a winery's keys (P4-09, ADR 0025).
 *
 * **Nothing here ever sees a plaintext secret key.** The caller generates it,
 * hashes it, hands the plaintext to the seller exactly once, and passes only
 * the hash and the hint down to these statements. A function that took the key
 * itself would be one careless log line away from writing it somewhere it
 * cannot be taken back from.
 *
 * **One row holds both keys, and that shapes both operations.** The public key
 * rotates by *replacing* the row — a new `pk_` needs a new row, because the old
 * one keeps resolving through its grace window (P4-08). The secret key rotates
 * by *updating* the active row in place, because it gets no grace at all: a
 * seller controls their own server's deployment, and the instant they rotate is
 * the instant the old key has to stop working.
 */

/** What the dashboard is allowed to know about a winery's keys. */
export interface ActiveKeys {
  readonly id: string;
  readonly publicKey: string;
  /** `sk_live_` and four characters. Never the key, never the hash. */
  readonly secretKeyPrefix: string;
  readonly secretKeyLast4: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewKeys {
  readonly publicKey: string;
  /** Hex SHA-256 of the secret key (ADR 0025). The key itself never gets here. */
  readonly secretKeyHash: string;
  readonly secretKeyPrefix: string;
  readonly secretKeyLast4: string;
}

interface KeysSqlRow {
  readonly id: string;
  readonly public_key: string;
  readonly secret_key_prefix: string;
  readonly secret_key_last4: string;
  readonly created_at: SqlTimestamp;
  readonly updated_at: SqlTimestamp;
}

/**
 * The columns a caller may read back.
 *
 * **`secret_key_hash` is not among them**, and that is a property worth more
 * than it looks. A hash of a 256-bit key cannot be reversed, but it can be
 * *replayed* against anything that trusts a hash rather than a key — so it has
 * no business leaving the database on any path, and the simplest way to make
 * sure it never does is to never select it.
 */
const VISIBLE = sql`id, public_key, secret_key_prefix, secret_key_last4, created_at, updated_at`;

const toKeys = (row: KeysSqlRow): ActiveKeys => ({
  id: row.id,
  publicKey: row.public_key,
  secretKeyPrefix: row.secret_key_prefix,
  secretKeyLast4: row.secret_key_last4,
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at),
});

/**
 * This winery's active keys, if it has any.
 *
 * No tenant in the `WHERE`: `widget_keys` is under RLS, so inside `withTenant`
 * this reaches one winery's rows. `revoked_at IS NULL` is the *active* key —
 * a public key in its grace window is still resolving, but it is not the one a
 * seller should be shown or should put on a new page.
 */
export const readActiveKeys = async (tx: DbTransaction): Promise<ActiveKeys | undefined> => {
  const rows = await tx.execute(sql`
    SELECT ${VISIBLE} FROM widget_keys WHERE revoked_at IS NULL LIMIT 1
  `);

  const row = [...rows][0] as KeysSqlRow | undefined;

  return row === undefined ? undefined : toKeys(row);
};

/**
 * Issues a winery's first keys.
 *
 * `undefined` when it already has an active pair — the partial unique index on
 * `(tenant_id) WHERE revoked_at IS NULL` decides, and `DO NOTHING` keeps the
 * refusal from aborting the transaction its audit row shares. Two simultaneous
 * "create my keys" clicks therefore produce one pair, and the second learns it
 * lost rather than silently replacing the first seller-visible secret.
 */
export const insertKeys = async (
  tx: DbTransaction,
  keys: NewKeys,
): Promise<ActiveKeys | undefined> => {
  const rows = await tx.execute(sql`
    INSERT INTO widget_keys (
      tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4
    )
    VALUES (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${keys.publicKey},
      ${keys.secretKeyHash},
      ${keys.secretKeyPrefix},
      ${keys.secretKeyLast4}
    )
    ON CONFLICT (tenant_id) WHERE revoked_at IS NULL DO NOTHING
    RETURNING ${VISIBLE}
  `);

  const row = [...rows][0] as KeysSqlRow | undefined;

  return row === undefined ? undefined : toKeys(row);
};

/**
 * Replaces the secret key on the active row, in place (P4-09).
 *
 * **No grace, and no new row.** A secret key lives on the seller's own server,
 * so the seller decides when their deployment changes — and the moment they
 * rotate is the moment the old key must stop working, because rotation is what
 * a seller does when they think a key has leaked. A grace window here would be
 * a window in which a leaked key still works.
 *
 * An update rather than a replacement for a second reason: the public key on
 * this row is live on the seller's pages, and a new row would mean a new `pk_`
 * — rotating a key they did not ask to rotate and breaking every page it is
 * installed on.
 */
export const replaceSecretKey = async (
  tx: DbTransaction,
  secret: Pick<NewKeys, 'secretKeyHash' | 'secretKeyPrefix' | 'secretKeyLast4'>,
): Promise<ActiveKeys | undefined> => {
  const rows = await tx.execute(sql`
    UPDATE widget_keys
    SET secret_key_hash = ${secret.secretKeyHash},
        secret_key_prefix = ${secret.secretKeyPrefix},
        secret_key_last4 = ${secret.secretKeyLast4},
        updated_at = now()
    WHERE revoked_at IS NULL
    RETURNING ${VISIBLE}
  `);

  const row = [...rows][0] as KeysSqlRow | undefined;

  return row === undefined ? undefined : toKeys(row);
};
