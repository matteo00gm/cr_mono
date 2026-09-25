import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

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
 */

export interface DomainRow {
  readonly id: string;
  readonly origin: string;
  readonly registrableDomain: string;
  readonly status: 'PENDING' | 'VERIFIED';
  readonly verificationToken: string | null;
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
  readonly created_at: Date;
}

const toDomain = (row: DomainSqlRow): DomainRow => ({
  id: row.id,
  origin: row.origin,
  registrableDomain: row.registrable_domain,
  status: row.status,
  verificationToken: row.verification_token,
  createdAt: row.created_at,
});

const COLUMNS = sql`id, origin, registrable_domain, status, verification_token, created_at`;

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
 * Creates a `PENDING` row, or reports that the origin is spoken for.
 *
 * `undefined` means the unique index refused it, and it deliberately does not
 * say by whom — there is no query that could answer that, and a caller that
 * could ask would be an oracle for enumerating who our customers are.
 */
export const insertDomain = async (
  tx: DbTransaction,
  domain: NewDomain,
): Promise<DomainRow | undefined> => {
  const rows = await tx.execute(sql`
    INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, verification_token)
    VALUES (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${domain.origin},
      ${domain.registrableDomain},
      ${domain.verificationToken}
    )
    ON CONFLICT (origin) DO NOTHING
    RETURNING ${COLUMNS}
  `);

  const row = [...rows][0] as DomainSqlRow | undefined;

  return row === undefined ? undefined : toDomain(row);
};

/** Every origin this tenant holds, pending or verified. Newest last. */
export const readDomains = async (tx: DbTransaction): Promise<readonly DomainRow[]> => {
  const rows = await tx.execute(sql`
    SELECT ${COLUMNS} FROM tenant_domains ORDER BY created_at, origin
  `);

  return [...rows].map((row) => toDomain(row as unknown as DomainSqlRow));
};
