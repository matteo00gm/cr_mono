import { sql } from 'drizzle-orm';

import type { tenantPlan } from './schema/tenants.js';
import { asDate, asDateOrNull, type SqlTimestamp } from './timestamps.js';
import type { DbTransaction } from './with-tenant.js';

type TenantPlan = (typeof tenantPlan.enumValues)[number];

/**
 * Adding a domain, and the one refusal that cannot be a query (P4-01, §3.2).
 *
 * **"That origin belongs to another tenant" is not something RLS lets us ask.**
 * The policy hides other tenants' rows, so a `SELECT` for an origin somebody
 * else holds returns nothing — indistinguishable from an origin nobody holds.
 * The global unique index on `origin` is the only thing that knows, and the
 * only way to consult it is to attempt the insert.
 *
 * **So the attempt is `ON CONFLICT DO NOTHING` rather than a caught `23505`.**
 * A raised constraint violation aborts the transaction, and the transaction is
 * the one the audit row has to be written in (P0-53) — catching the error would
 * leave nothing able to record that the attempt happened. An empty `RETURNING`
 * carries the same information and leaves the transaction usable.
 *
 * **The plan cap is counted and spent in one transaction, serialised on the
 * tenant's own row** (P4-07). Counting and then inserting is the same race the
 * last-OWNER guard has: two concurrent adds each see the winery one under its
 * cap and both succeed. The usual answer — lock the rows you counted — does not
 * work here, because the set being counted is often *empty* and there is no way
 * to lock rows that do not exist. So the lock goes on the one row that always
 * exists: the winery's own.
 */

export interface DomainRow {
  readonly id: string;
  readonly origin: string;
  readonly registrableDomain: string;
  readonly status: 'PENDING' | 'VERIFIED';
  readonly verificationToken: string | null;
  /** When the nonce stops being accepted (P4-04). Null once it has been used. */
  readonly verificationExpiresAt: Date | null;
  readonly createdAt: Date;
}

export interface NewDomain {
  readonly origin: string;
  readonly registrableDomain: string;
  readonly verificationToken: string;
}

interface DomainSqlRow {
  readonly id: string;
  readonly origin: string;
  readonly registrable_domain: string;
  readonly status: 'PENDING' | 'VERIFIED';
  readonly verification_token: string | null;
  readonly verification_expires_at: SqlTimestamp | null;
  readonly created_at: SqlTimestamp;
}

const toDomain = (row: DomainSqlRow): DomainRow => ({
  id: row.id,
  origin: row.origin,
  registrableDomain: row.registrable_domain,
  status: row.status,
  verificationToken: row.verification_token,
  verificationExpiresAt: asDateOrNull(row.verification_expires_at),
  createdAt: asDate(row.created_at),
});

const COLUMNS = sql`
  id, origin, registrable_domain, status,
  verification_token, verification_expires_at, created_at
`;

/**
 * How long a nonce is accepted for (P4-04).
 *
 * **Seven days, and the length is a judgement rather than a constant somebody
 * picked.** DNS is not always the seller's to change — plenty of them have to
 * ask whoever built the site — so a window of hours would fail honest
 * customers, and one that never closed would leave a live proof lying in a
 * public TXT record for a domain we may later have to contest (P4-18).
 *
 * Computed in SQL from `now()`, never passed in: a clock the caller supplies is
 * a clock the caller can move.
 */
const VERIFICATION_WINDOW = sql`interval '7 days'`;

/**
 * This tenant's own row for an origin, if it has one.
 *
 * The tenant is never named in the `WHERE`: `tenant_domains` is under RLS, so
 * inside `withTenant` this reaches exactly one winery's rows (P0-19). A row
 * that comes back is therefore the caller's own by construction, which is what
 * makes it safe to describe in the response — unlike the conflict above.
 */
export const readDomainByOrigin = async (
  tx: DbTransaction,
  origin: string,
): Promise<DomainRow | undefined> => {
  const rows = await tx.execute(sql`
    SELECT ${COLUMNS} FROM tenant_domains WHERE origin = ${origin} LIMIT 1
  `);

  const row = [...rows][0] as DomainSqlRow | undefined;

  return row === undefined ? undefined : toDomain(row);
};

/**
 * What the attempt did. Three outcomes rather than a row-or-nothing, because
 * they are three different things to tell a seller: one is a conflict they can
 * do nothing about, one is a plan they can change, and one is a domain they now
 * have to verify.
 */
export type DomainInsert =
  | { readonly outcome: 'created'; readonly domain: DomainRow }
  | { readonly outcome: 'taken' }
  | { readonly outcome: 'at-cap'; readonly held: number };

/**
 * Locks the winery's own row.
 *
 * **The set of domains may be empty, and you cannot lock rows that do not
 * exist** — so this is what serialises two simultaneous adds. One row, always
 * present, and every domain write for this winery queues behind it. `tenants`
 * is under RLS, so inside `withTenant` this reaches exactly one row without
 * naming it.
 */
const lockTenant = async (tx: DbTransaction): Promise<void> => {
  await tx.execute(sql`SELECT 1 FROM tenants FOR UPDATE`);
};

/** How many origins this winery holds, pending and verified alike. */
export const countDomains = async (tx: DbTransaction): Promise<number> => {
  const rows = await tx.execute(sql`SELECT count(*)::int AS held FROM tenant_domains`);
  const row = [...rows][0] as { held?: number } | undefined;

  return row?.held ?? 0;
};

/**
 * Creates a `PENDING` row, or reports why it did not.
 *
 * `taken` deliberately does not say by whom — there is no query that could
 * answer that, and a caller that could ask would be an oracle for enumerating
 * who our customers are.
 */
export const insertDomain = async (
  tx: DbTransaction,
  domain: NewDomain,
  cap: number,
): Promise<DomainInsert> => {
  await lockTenant(tx);

  const held = await countDomains(tx);

  if (held >= cap) return { outcome: 'at-cap', held };

  const rows = await tx.execute(sql`
    INSERT INTO tenant_domains (
      tenant_id, origin, registrable_domain, verification_token, verification_expires_at
    )
    VALUES (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${domain.origin},
      ${domain.registrableDomain},
      ${domain.verificationToken},
      now() + ${VERIFICATION_WINDOW}
    )
    ON CONFLICT (origin) DO NOTHING
    RETURNING ${COLUMNS}
  `);

  const row = [...rows][0] as DomainSqlRow | undefined;

  return row === undefined ? { outcome: 'taken' } : { outcome: 'created', domain: toDomain(row) };
};

/** Every origin this tenant holds, pending or verified. Newest last. */
export const readDomains = async (tx: DbTransaction): Promise<readonly DomainRow[]> => {
  const rows = await tx.execute(sql`
    SELECT ${COLUMNS} FROM tenant_domains ORDER BY created_at, origin
  `);

  return [...rows].map((row) => toDomain(row as unknown as DomainSqlRow));
};

/**
 * The winery's plan, which decides its cap (P4-07).
 *
 * `null` for a tenant that has not chosen one — every tenant is that between
 * signup and checkout — and the caller turns that into an allowance rather than
 * a refusal. No `WHERE` clause: `tenants`' policy is `id = app.tenant_id`, so
 * inside `withTenant` this table holds exactly one visible row, and a redundant
 * predicate would suggest the isolation comes from the query rather than from
 * the policy.
 */
export const readTenantPlan = async (tx: DbTransaction): Promise<TenantPlan | null> => {
  const rows = await tx.execute(sql`SELECT plan FROM tenants LIMIT 1`);
  const row = [...rows][0] as { plan?: TenantPlan | null } | undefined;

  return row?.plan ?? null;
};

/**
 * One of this winery's domains by id.
 *
 * `undefined` for an id that belongs to another winery *and* for one that does
 * not exist, because RLS makes them the same query result — which is exactly
 * what §3.5 wants the caller to answer 404 to. The distinction an attacker
 * would like is one this statement cannot express.
 */
export const readDomainById = async (
  tx: DbTransaction,
  id: string,
): Promise<DomainRow | undefined> => {
  const rows = await tx.execute(sql`
    SELECT ${COLUMNS} FROM tenant_domains WHERE id = ${id}::uuid LIMIT 1
  `);

  const row = [...rows][0] as DomainSqlRow | undefined;

  return row === undefined ? undefined : toDomain(row);
};

/**
 * Stamps a domain verified (P4-02).
 *
 * **`WHERE status = 'PENDING'` is in the statement rather than beside it**, on
 * `setMemberRole`'s reasoning: a caller that checked first and updated second
 * has a guard with a bypass, and two verifications arriving together would both
 * pass it. An empty result means somebody else got there first, which is a
 * success from the seller's point of view and not something to report as one
 * from ours.
 *
 * The tenant is never named: the policy is what scopes this (P0-19).
 */
export const markDomainVerified = async (
  tx: DbTransaction,
  id: string,
  method: 'DNS_TXT' | 'WELL_KNOWN',
): Promise<DomainRow | undefined> => {
  const rows = await tx.execute(sql`
    UPDATE tenant_domains
    SET status = 'VERIFIED',
        verified_at = now(),
        verification_method = ${method}::domain_verification_method,
        -- Single use (P4-04). The nonce is in a public TXT record, and one that
        -- keeps working is a proof anybody who reads that record can replay.
        verification_token = null,
        verification_expires_at = null,
        updated_at = now()
    WHERE id = ${id}::uuid AND status = 'PENDING'
    RETURNING ${COLUMNS}
  `);

  const row = [...rows][0] as DomainSqlRow | undefined;

  return row === undefined ? undefined : toDomain(row);
};

/**
 * Issues a fresh nonce for a claim whose old one has lapsed (P4-04).
 *
 * **A new value rather than a new window on the old one.** The lapsed nonce has
 * been sitting in a public TXT record for a week; extending it would mean the
 * thing that proves control is a thing anybody who looked has a copy of.
 *
 * `WHERE status = 'PENDING'` for `markDomainVerified`'s reason — a verified
 * domain must not be handed a nonce, which would reopen a closed proof.
 */
export const reissueVerification = async (
  tx: DbTransaction,
  id: string,
  token: string,
): Promise<DomainRow | undefined> => {
  const rows = await tx.execute(sql`
    UPDATE tenant_domains
    SET verification_token = ${token},
        verification_expires_at = now() + ${VERIFICATION_WINDOW},
        updated_at = now()
    WHERE id = ${id}::uuid AND status = 'PENDING'
    RETURNING ${COLUMNS}
  `);

  const row = [...rows][0] as DomainSqlRow | undefined;

  return row === undefined ? undefined : toDomain(row);
};
