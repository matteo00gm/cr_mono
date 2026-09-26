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

/**
 * How long a rotated public key keeps resolving (P4-08).
 *
 * A day, because rotation cannot be atomic: the old key is in a script tag on
 * the seller's pages until they redeploy, and a window measured in minutes
 * would break their live storefront the moment they pressed the button.
 * Computed by the database, for the reason `VERIFICATION_WINDOW` gives.
 */
const PUBLIC_KEY_GRACE = sql`interval '24 hours'`;

/** A public key that has been rotated away from and still resolves. */
export interface KeyInGrace {
  readonly publicKey: string;
  readonly graceUntil: Date;
}

/**
 * The public key in its grace window, if there is one.
 *
 * At most one, because rotation ends any earlier grace (see below). `now()` in
 * the predicate rather than a clock from the caller, so what the dashboard
 * shows as live is exactly what resolution (P2-07) treats as live.
 */
export const readKeyInGrace = async (tx: DbTransaction): Promise<KeyInGrace | undefined> => {
  const rows = await tx.execute(sql`
    SELECT public_key, grace_until FROM widget_keys
    WHERE revoked_at IS NOT NULL AND grace_until > now()
    ORDER BY grace_until DESC
    LIMIT 1
  `);

  const row = [...rows][0] as { public_key: string; grace_until: SqlTimestamp } | undefined;

  return row === undefined
    ? undefined
    : { publicKey: row.public_key, graceUntil: asDate(row.grace_until) };
};

/**
 * Replaces the public key, keeping the old one resolving for a day (P4-08).
 *
 * Four statements in the caller's transaction, and the order is the design:
 *
 * 1. **Lock the winery's own row.** Two simultaneous rotations would otherwise
 *    each find the same active key; the second would then find none at all and
 *    report that the winery has no keys. P4-07 has the same race and the same
 *    answer: lock the one row that always exists.
 * 2. **End any earlier grace.** At most one old key resolves at a time. A
 *    seller rotates *because* they think a key has leaked, and rotating again
 *    must not leave the first leaked key alive beside the second.
 * 3. **Revoke the active key, with a day's grace.** Before the insert, because
 *    the partial unique index allows one active key per tenant and checks it
 *    per statement.
 * 4. **Insert the new key, carrying the secret across.** One row holds both
 *    keys, and the secret key is on the seller's server — rotating the public
 *    key must not rotate a secret they did not ask to change.
 *
 * The old row keeps its secret-key hash, and that is safe only because every
 * secret-key lookup (P4-10) is restricted to `revoked_at IS NULL`: a secret is
 * live on the active row and nowhere else.
 */
export const rotatePublicKey = async (
  tx: DbTransaction,
  publicKey: string,
): Promise<{ readonly active: ActiveKeys; readonly previous: KeyInGrace } | undefined> => {
  await tx.execute(sql`SELECT 1 FROM tenants FOR UPDATE`);

  await tx.execute(sql`
    UPDATE widget_keys SET grace_until = now(), updated_at = now()
    WHERE revoked_at IS NOT NULL AND grace_until > now()
  `);

  const revoked = await tx.execute(sql`
    UPDATE widget_keys
    SET revoked_at = now(), grace_until = now() + ${PUBLIC_KEY_GRACE}, updated_at = now()
    WHERE revoked_at IS NULL
    RETURNING public_key, grace_until, secret_key_hash, secret_key_prefix, secret_key_last4
  `);

  const old = [...revoked][0] as
    | {
        public_key: string;
        grace_until: SqlTimestamp;
        secret_key_hash: string;
        secret_key_prefix: string;
        secret_key_last4: string;
      }
    | undefined;

  if (old === undefined) return undefined;

  const inserted = await tx.execute(sql`
    INSERT INTO widget_keys (
      tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4
    )
    VALUES (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${publicKey},
      ${old.secret_key_hash},
      ${old.secret_key_prefix},
      ${old.secret_key_last4}
    )
    RETURNING ${VISIBLE}
  `);

  /*
   * The insert cannot come back empty: the active key was revoked two
   * statements ago under a lock nobody else holds, so the partial unique index
   * has room. A missing row here would mean that reasoning had broken, and the
   * honest response to that is to stop rather than report a rotation.
   */
  const row = [...inserted][0] as unknown as KeysSqlRow | undefined;

  if (row === undefined) throw new Error('rotatePublicKey: the new key was not inserted');

  return {
    active: toKeys(row),
    previous: { publicKey: old.public_key, graceUntil: asDate(old.grace_until) },
  };
};
