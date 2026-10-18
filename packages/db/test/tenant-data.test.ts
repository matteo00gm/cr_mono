import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { Database } from '../src/client.js';
import {
  eraseTenant,
  ErasureRefusedError,
  readTenantExport,
  recordExport,
  tenantTables,
} from '../src/tenant-data.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * A winery's export and erasure without a database (P7-08): which statements
 * each issues, in what order, and what it makes of the answers. What they
 * reach, under which role and policy, is `tenant-data.integration.test.ts`'s.
 */

const dialect = new PgDialect();

interface Issued {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * A database that answers by what was asked: `answer` sees each statement's
 * text and parameters, in order, and returns its rows.
 */
const fakeDb = (answer: (statement: Issued, issued: readonly Issued[]) => unknown[]) => {
  const issued: Issued[] = [];
  const tx = {
    execute: (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      const entry = { sql: query.sql.replace(/\s+/gu, ' ').trim(), params: query.params };

      issued.push(entry);

      return Promise.resolve(answer(entry, issued));
    },
  } as unknown as DbTransaction;
  const db = {
    transaction: (work: (t: DbTransaction) => unknown) => work(tx),
  } as unknown as Database;

  return { tx, db, issued };
};

const TENANT = '0b3c6f0e-2a8b-4c1d-9e7f-5a6b7c8d9e0f';

describe('the tables', () => {
  it('are every table with a tenant_id, from the catalogue, by name', async () => {
    const fake = fakeDb(() => [{ table_name: 'audit_log' }, { table_name: 'products' }]);

    expect(await tenantTables(fake.tx)).toEqual(['audit_log', 'products']);
    expect(fake.issued[0]?.sql).toMatch(
      /FROM information_schema\.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name/u,
    );
  });
});

describe('the export', () => {
  it('is nothing, and reads nothing else, when the winery is not there', async () => {
    const fake = fakeDb(() => []);

    expect(await readTenantExport(fake.tx, TENANT)).toBeUndefined();
    expect(fake.issued).toHaveLength(1);
  });

  it('reads each table but the embeddings, by winery, and leaves credentials out of every row', async () => {
    const fake = fakeDb(({ sql }) => {
      if (sql.startsWith('SELECT * FROM tenants')) return [{ id: TENANT, name: 'Cantina srl' }];
      if (sql.includes('FROM memberships m JOIN auth_users u')) {
        return [{ id: 'u1', name: 'Giulia', email: 'g@example.test', role: 'OWNER' }];
      }
      if (sql.includes('information_schema')) {
        return [
          { table_name: 'product_embeddings' },
          { table_name: 'widget_keys' },
          { table_name: 'invitations' },
        ];
      }
      if (sql.includes('"widget_keys"')) {
        return [
          {
            id: 'k1',
            public_key: 'pk',
            secret_key_hash: 'h',
            secret_key_prefix: 'p',
            secret_key_last4: 'l',
          },
        ];
      }
      if (sql.includes('"invitations"'))
        return [{ id: 'i1', email: 'm@example.test', token_hash: 't' }];

      return [];
    });

    const archive = await readTenantExport(fake.tx, TENANT);

    expect(archive).toEqual({
      tenant: { id: TENANT, name: 'Cantina srl' },
      members: [{ id: 'u1', name: 'Giulia', email: 'g@example.test', role: 'OWNER' }],
      tables: {
        widget_keys: [{ id: 'k1', public_key: 'pk' }],
        invitations: [{ id: 'i1', email: 'm@example.test' }],
      },
    });
    expect(fake.issued.some(({ sql }) => sql.includes('"product_embeddings"'))).toBe(false);

    for (const { sql, params } of fake.issued.filter((statement) =>
      statement.sql.startsWith('SELECT * FROM "'),
    )) {
      expect(sql).toMatch(/WHERE tenant_id = \$1::uuid$/u);
      expect(params).toEqual([TENANT]);
    }
  });

  it('is recorded as a count, by nobody in particular', async () => {
    const fake = fakeDb(() => []);

    await recordExport(fake.tx, TENANT, 42);

    expect(fake.issued[0]?.sql).toMatch(/^insert into audit_log/u);
    expect(fake.issued[0]?.params).toEqual([
      TENANT,
      null,
      'tenant.exported',
      null,
      JSON.stringify({ rows: 42 }),
      null,
      null,
    ]);
  });
});

/**
 * A winery as the erasure's statements find it, before and after: its row, its
 * tables' counts, its members and how many wineries each belongs to, and what
 * is left once it is gone.
 */
interface Winery {
  /** `null` for no winery: `undefined` would be the default, and a winery. */
  readonly tenant?: Record<string, unknown> | null;
  readonly pending?: unknown[];
  readonly counts?: Record<string, number>;
  readonly members?: Record<string, number>;
  readonly shops?: string[];
  readonly left?: Record<string, number>;
}

const winery = ({
  tenant = {
    slug: 'cantina',
    name: 'Cantina srl',
    vat_id: '12345678901',
    sdi_code: 'ABC1234',
    pec_address: null,
    stripe_subscription_id: null,
  },
  pending = [{ n: 0 }],
  counts = { products: 3, e_invoices: 2 },
  members = { u1: 1, u2: 2 },
  shops = [],
  left = {},
}: Winery = {}) =>
  fakeDb(({ sql, params }, issued) => {
    const erased = issued.some((statement) => statement.sql.startsWith('DELETE FROM tenants'));

    if (sql.startsWith('SELECT slug, name')) return tenant === null ? [] : [tenant];
    if (sql.includes("status = 'pending'")) return pending;
    if (sql.includes('information_schema')) {
      return Object.keys(counts).map((table_name) => ({ table_name }));
    }
    if (sql.startsWith('SELECT count(*)::int AS n FROM "')) {
      const table = /FROM "([a-z_]+)"/u.exec(sql)?.[1] ?? '';

      return erased ? (table in left ? [{ n: left[table] }] : []) : [{ n: counts[table] }];
    }
    if (sql.startsWith('SELECT user_id FROM memberships')) {
      return Object.keys(members).map((user_id) => ({ user_id }));
    }
    if (sql.startsWith('SELECT count(*)::int AS n FROM memberships WHERE user_id')) {
      const held = members[String(params[0])];

      return held === undefined ? [] : [{ n: held }];
    }
    if (sql.includes('FROM shopify_installations')) return shops.map((shop) => ({ shop }));

    return [];
  });

const statements = (fake: ReturnType<typeof fakeDb>) => fake.issued.map(({ sql }) => sql);

describe('the erasure', () => {
  it('is a dry run unless told otherwise: it counts, and writes nothing', async () => {
    const fake = winery({ shops: ['cantina.myshopify.com'] });

    expect(await eraseTenant(fake.db, TENANT)).toEqual({
      tenantId: TENANT,
      slug: 'cantina',
      dryRun: true,
      rows: { products: 3, e_invoices: 2 },
      chargesKept: 2,
      accountsErased: 1,
      accountsKept: 1,
      shopsConnected: ['cantina.myshopify.com'],
    });
    expect(statements(fake).filter((sql) => /^(UPDATE|DELETE)/u.test(sql))).toEqual([]);
  });

  it('copies the buyer, deletes the winery, then the accounts that belonged nowhere else, in that order', async () => {
    const fake = winery();
    const receipt = await eraseTenant(fake.db, TENANT, { dryRun: false });

    expect(receipt.dryRun).toBe(false);

    const writes = fake.issued.filter(({ sql }) => /^(UPDATE|DELETE)/u.test(sql));

    expect(writes.map(({ sql }) => sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'UPDATE e_invoices SET',
      'DELETE FROM tenants',
      'DELETE FROM auth_users',
    ]);
    expect(writes[0]?.params).toEqual(['Cantina srl', '12345678901', 'ABC1234', null, TENANT]);
    expect(writes[0]?.sql).toContain('buyer_kept_at = now()');
    expect(writes[2]?.params).toEqual(['u1']);
  });

  it('counts each member’s memberships in the member’s own scope, and goes back to the winery’s', async () => {
    const fake = winery();

    await eraseTenant(fake.db, TENANT);

    const scopes = fake.issued
      .filter(({ sql }) => sql.includes('set_config'))
      .map(({ params }) => params);

    expect(scopes).toEqual([
      [TENANT, ''],
      ['', 'u1'],
      ['', 'u2'],
      [TENANT, ''],
    ]);
  });

  it('deletes no account when every member belongs elsewhere too, and reads a missing count as none', async () => {
    const fake = winery({ members: { u2: 2, u3: 3 }, counts: { products: 1 } });
    const receipt = await eraseTenant(fake.db, TENANT, { dryRun: false });

    expect(receipt).toMatchObject({ accountsErased: 0, accountsKept: 2, chargesKept: 0 });
    expect(statements(fake).some((sql) => sql.startsWith('DELETE FROM auth_users'))).toBe(false);
  });

  it('takes a member whose memberships cannot be counted as belonging nowhere else', async () => {
    const lonely = fakeDb(({ sql }) => {
      if (sql.startsWith('SELECT slug, name'))
        return [{ slug: 's', name: 'n', stripe_subscription_id: null }];
      if (sql.startsWith('SELECT user_id FROM memberships')) return [{ user_id: 'u9' }];

      return [];
    });

    expect(await eraseTenant(lonely.db, TENANT)).toMatchObject({
      rows: {},
      chargesKept: 0,
      accountsErased: 1,
      accountsKept: 0,
    });
  });

  it('refuses a winery that is not there, one still subscribed, and one owed an invoice', async () => {
    await expect(eraseTenant(winery({ tenant: null }).db, TENANT)).rejects.toThrow(
      `There is no winery ${TENANT}.`,
    );

    const subscribed = winery({
      tenant: { slug: 's', name: 'n', stripe_subscription_id: 'sub_1' },
    });

    await expect(eraseTenant(subscribed.db, TENANT, { dryRun: false })).rejects.toBeInstanceOf(
      ErasureRefusedError,
    );
    expect(statements(subscribed).some((sql) => /^(UPDATE|DELETE)/u.test(sql))).toBe(false);

    await expect(eraseTenant(winery({ pending: [{ n: 3 }] }).db, TENANT)).rejects.toThrow(
      'This winery has 3 charges still waiting for their invoice. Issue them first.',
    );
    /* No count at all is none owed. */
    await expect(eraseTenant(winery({ pending: [] }).db, TENANT)).resolves.toMatchObject({
      dryRun: true,
    });
  });

  it('fails when a table still names the winery once it is gone', async () => {
    const fake = winery({
      left: { products: 0, e_invoices: 0, stray: 2 },
      counts: { products: 3, stray: 2 },
    });

    await expect(eraseTenant(fake.db, TENANT, { dryRun: false })).rejects.toThrow(
      'stray still holds 2 rows for this winery after its erasure; nothing was erased.',
    );
  });
});
