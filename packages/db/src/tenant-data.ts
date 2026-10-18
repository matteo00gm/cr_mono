import { sql } from 'drizzle-orm';

import { insertAuditRow } from './audit.js';
import type { Database } from './client.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * A winery's data, whole: read out for it, and erased (P7-08, ADR 0033).
 *
 * Operator work, run from `scripts/tenant-export.mjs` and
 * `scripts/tenant-delete.mjs` and nowhere in a request. **Every table is found
 * in the catalogue, not listed here**: a table with a `tenant_id` is a
 * winery's, so a table added next year is in the export and in the erasure's
 * check on the day it is created, and nobody has to remember this file.
 */

/**
 * Left out of an export, each for a reason that is not "we forgot".
 *
 * Embeddings are a model's reading of the products, which are exported: a
 * thousand numbers per wine that nobody can read and the products make again.
 */
export const NOT_EXPORTED: Readonly<Record<string, string>> = {
  product_embeddings: 'derived from products, which are exported, and regenerated from them',
};

/**
 * Columns that are credentials rather than data, left out of every row.
 *
 * A key's hash, an invitation's token hash, an OAuth state's nonce, the value a
 * DNS record was asked to hold: each is how something was proved, and an
 * archive handed to a winery — or to whoever its inbox forwards to — is not a
 * place for one.
 */
export const OMITTED_COLUMNS: ReadonlySet<string> = new Set([
  'secret_key_hash',
  'secret_key_prefix',
  'secret_key_last4',
  'token_hash',
  'nonce_hash',
  'verification_token',
]);

/** Every table with a `tenant_id`, from the catalogue, in name order. */
export const tenantTables = async (tx: DbTransaction): Promise<string[]> => {
  const rows = await tx.execute(sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
    ORDER BY table_name
  `);

  return [...rows].map((row) => (row as { table_name: string }).table_name);
};

const withoutCredentials = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([column]) => !OMITTED_COLUMNS.has(column)));

export interface TenantExport {
  /** The winery's own row. */
  readonly tenant: Record<string, unknown>;
  /** Its members: who they are, and in what role. Never a password or a session. */
  readonly members: readonly Record<string, unknown>[];
  /** Every other table with its rows, by name. */
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

/**
 * Everything one winery has, read in its own scope (`withTenant`).
 *
 * **Two fences, not one.** The policy admits only this winery's rows, and every
 * read says `WHERE tenant_id` as well, so a policy that one day admits more —
 * a second scope's branch, a mistake — still cannot put another winery's row
 * in somebody's archive.
 */
export const readTenantExport = async (
  tx: DbTransaction,
  tenantId: string,
): Promise<TenantExport | undefined> => {
  const tenants = await tx.execute(sql`SELECT * FROM tenants WHERE id = ${tenantId}::uuid`);
  const tenant = [...tenants][0];

  if (tenant === undefined) return undefined;

  const members = await tx.execute(sql`
    SELECT u.id, u.name, u.email, u.created_at, m.role
    FROM memberships m JOIN auth_users u ON u.id = m.user_id
    WHERE m.tenant_id = ${tenantId}::uuid
    ORDER BY u.created_at
  `);

  const tables: Record<string, Record<string, unknown>[]> = {};

  for (const table of await tenantTables(tx)) {
    if (table in NOT_EXPORTED) continue;

    const rows = await tx.execute(
      sql`SELECT * FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}::uuid`,
    );

    tables[table] = [...rows].map((row) => withoutCredentials(row));
  }

  return {
    tenant: withoutCredentials(tenant),
    members: [...members] as Record<string, unknown>[],
    tables,
  };
};

/**
 * The export, in the winery's own audit log, in the transaction that read it:
 * an archive of everything a winery has is something its owner should be able
 * to see was made. The count, never the contents.
 */
export const recordExport = async (
  tx: DbTransaction,
  tenantId: string,
  rows: number,
): Promise<void> =>
  insertAuditRow(tx, {
    tenantId,
    actorUserId: undefined,
    action: 'tenant.exported',
    target: undefined,
    metadata: JSON.stringify({ rows }),
    ip: undefined,
    userAgent: undefined,
  });

/* ------------------------------------------------------------ erasure */

/** Why an erasure did not happen, in words the operator can act on. Nothing was written. */
export class ErasureRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ErasureRefusedError';
  }
}

export interface ErasureReceipt {
  readonly tenantId: string;
  readonly slug: string;
  readonly dryRun: boolean;
  /** Rows the winery had, by table: what went, or in a dry run what would have. */
  readonly rows: Readonly<Record<string, number>>;
  /** Charges kept, detached, with the buyer's identity copied onto them. */
  readonly chargesKept: number;
  /** Member accounts that belonged to this winery and no other, and went with it. */
  readonly accountsErased: number;
  /** Member accounts that also belong to another winery, kept with their other memberships. */
  readonly accountsKept: number;
  /**
   * Shopify shops still connected, whose tokens are in SSM and not in this
   * database (ADR 0031): the operator removes each one by hand.
   */
  readonly shopsConnected: readonly string[];
}

const one = async <T>(
  tx: DbTransaction,
  statement: ReturnType<typeof sql>,
): Promise<T | undefined> => [...(await tx.execute(statement))][0] as T | undefined;

/**
 * Erases one winery, keeping its fiscal records (ADR 0033).
 *
 * **Run as the migration role**, which owns the tables and may delete a winery,
 * and which the runtime role may not (migration 0029). **Scoped all the same**:
 * every statement here runs with `app.tenant_id` set, so the policies that bind
 * the owner (`FORCE ROW LEVEL SECURITY`) still keep it to one winery. The
 * cascades the delete sets off are the database's own and see every row they
 * must.
 *
 * **One transaction**, so an erasure that cannot finish leaves the winery as it
 * was; and a check at the end that no table holds a row for it any more, so a
 * table that does not cascade fails the erasure instead of keeping a copy.
 */
export const eraseTenant = async (
  db: Database,
  tenantId: string,
  { dryRun = true }: { readonly dryRun?: boolean | undefined } = {},
): Promise<ErasureReceipt> =>
  db.transaction(async (tx) => {
    const scope = (tenant: string, user: string) =>
      tx.execute(
        sql`SELECT set_config('app.tenant_id', ${tenant}, true), set_config('app.user_id', ${user}, true)`,
      );

    await scope(tenantId, '');

    const tenant = await one<{
      slug: string;
      name: string;
      vat_id: string | null;
      sdi_code: string | null;
      pec_address: string | null;
      stripe_subscription_id: string | null;
    }>(
      tx,
      sql`SELECT slug, name, vat_id, sdi_code, pec_address, stripe_subscription_id
          FROM tenants WHERE id = ${tenantId}::uuid`,
    );

    if (tenant === undefined) throw new ErasureRefusedError(`There is no winery ${tenantId}.`);

    /*
     * **Billing ends before the winery does.** A live subscription goes on
     * charging a card for a winery that no longer exists; Stripe's webhook
     * clears the column when the subscription ends (P5-05).
     */
    if (tenant.stripe_subscription_id !== null) {
      throw new ErasureRefusedError(
        'This winery still has a subscription. Cancel it in Stripe first; the webhook ends it here.',
      );
    }

    /*
     * **An invoice owed is issued before the buyer goes.** The bridge finds
     * pending charges by winery (P5-03a), and a detached one it would never
     * find: that is an invoice nobody issues.
     */
    const pending = await one<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM e_invoices WHERE tenant_id = ${tenantId}::uuid AND status = 'pending'`,
    );

    if ((pending?.n ?? 0) > 0) {
      throw new ErasureRefusedError(
        `This winery has ${String(pending?.n)} charges still waiting for their invoice. Issue them first.`,
      );
    }

    const tables = await tenantTables(tx);
    const rows: Record<string, number> = {};

    for (const table of tables) {
      const counted = await one<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}::uuid`,
      );

      rows[table] = counted?.n ?? 0;
    }

    /*
     * **Which members go with it.** Counted per member in the member's own
     * scope (`app.user_id`, the `withUser` branch of the memberships policy):
     * in the winery's scope a member's other memberships are invisible, and
     * "belongs to nothing else" would be true of everybody.
     */
    const members = [
      ...(await tx.execute(
        sql`SELECT user_id FROM memberships WHERE tenant_id = ${tenantId}::uuid`,
      )),
    ].map((row) => (row as { user_id: string }).user_id);
    const erasedAccounts: string[] = [];

    for (const userId of members) {
      await scope('', userId);

      const held = await one<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM memberships WHERE user_id = ${userId}`,
      );

      if ((held?.n ?? 0) <= 1) erasedAccounts.push(userId);
    }

    await scope(tenantId, '');

    const shops = [
      ...(await tx.execute(
        sql`SELECT shop FROM shopify_installations
            WHERE tenant_id = ${tenantId}::uuid AND uninstalled_at IS NULL ORDER BY shop`,
      )),
    ].map((row) => (row as { shop: string }).shop);

    const receipt: ErasureReceipt = {
      tenantId,
      slug: tenant.slug,
      dryRun,
      rows,
      chargesKept: rows.e_invoices ?? 0,
      accountsErased: erasedAccounts.length,
      accountsKept: members.length - erasedAccounts.length,
      shopsConnected: shops,
    };

    if (dryRun) return receipt;

    /* The buyer, copied onto every charge before the row it was read from goes. */
    await tx.execute(sql`
      UPDATE e_invoices
      SET buyer_name = ${tenant.name}, buyer_vat_id = ${tenant.vat_id},
          buyer_sdi_code = ${tenant.sdi_code}, buyer_pec_address = ${tenant.pec_address},
          buyer_kept_at = now()
      WHERE tenant_id = ${tenantId}::uuid
    `);

    await tx.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}::uuid`);

    if (erasedAccounts.length > 0) {
      await tx.execute(
        sql`DELETE FROM auth_users WHERE id IN (${sql.join(
          erasedAccounts.map((userId) => sql`${userId}`),
          sql`, `,
        )})`,
      );
    }

    /* Nothing left that names it: a table that does not cascade fails the erasure here. */
    for (const table of tables) {
      const left = await one<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}::uuid`,
      );

      if ((left?.n ?? 0) > 0) {
        throw new ErasureRefusedError(
          `${table} still holds ${String(left?.n)} rows for this winery after its erasure; nothing was erased.`,
        );
      }
    }

    return receipt;
  });
