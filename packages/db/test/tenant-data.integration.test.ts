import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import {
  eraseTenant,
  ErasureRefusedError,
  NOT_EXPORTED,
  OMITTED_COLUMNS,
  readTenantExport,
  recordExport,
  tenantTables,
} from '../src/tenant-data.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';

/**
 * A winery's data, whole (P7-08, ADR 0033), against Postgres.
 *
 * **The row's important assertion is the export's**: every table a winery has
 * rows in is in its archive, and nothing from another winery is. Then the
 * erasure: everything goes but the charges, which stay with the buyer on them;
 * a member who belongs elsewhere keeps their account; and a dry run, or a
 * refusal, changes nothing.
 *
 * The export runs as `app_rw` in the winery's scope, and the erasure as the
 * migration role, which is how the scripts run them.
 */

let container: StartedPostgreSqlContainer | undefined;
const clients: DbClient[] = [];
let runtime: Database;
let migrate: Database;
let admin: Database;
let urls: { readonly runtime: string; readonly migrate: string };

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  urls = { runtime: started.roleUrl('app_rw'), migrate: started.roleUrl('app_migrate') };

  const connect = (url: string): Database => {
    const client = createDbClient(url, { max: 1 });
    clients.push(client);

    return client.db;
  };

  runtime = connect(started.roleUrl('app_rw'));
  migrate = connect(started.roleUrl('app_migrate'));
  admin = connect(started.adminUrl);
}, 180_000);

afterAll(async () => {
  for (const client of clients) await client.close();
  await container?.stop();
}, 60_000);

/**
 * A winery with a row in as many of its tables as a test can give it rows in,
 * seeded as the superuser, past RLS.
 */
const winery = async (label: string, owner = `user_${randomUUID()}`) => {
  const id = randomUUID();

  await admin.execute(sql`
    INSERT INTO tenants (id, name, slug, vat_id, sdi_code)
    VALUES (${id}::uuid, ${`${label} srl`}, ${`${label}-${id}`}, '12345678901', 'ABC1234')
  `);
  await admin.execute(sql`
    INSERT INTO auth_users (id, name, email) VALUES (${owner}, 'Giulia', ${`${owner}@example.test`})
    ON CONFLICT (id) DO NOTHING
  `);
  await admin.execute(sql`
    INSERT INTO memberships (tenant_id, user_id, role) VALUES (${id}::uuid, ${owner}, 'OWNER')
  `);

  const products = await admin.execute(sql`
    INSERT INTO products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
    VALUES (${id}::uuid, ${`sku-${randomUUID()}`}, 'Barolo', 'red', 2000, 'EUR', 'IN_STOCK')
    RETURNING id
  `);
  const productId = ([...products][0] as { id: string }).id;

  await admin.execute(sql`
    INSERT INTO product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model, version)
    VALUES (${id}::uuid, ${productId}::uuid, 0, 'h',
            ${JSON.stringify(Array.from({ length: 1024 }, () => 0.1))}::halfvec,
            'amazon.titan-embed-text-v2:0', 1)
  `);

  const conversations = await admin.execute(sql`
    INSERT INTO conversations (tenant_id, session_id, origin, locale)
    VALUES (${id}::uuid, ${`s-${randomUUID()}`}, 'https://cantina.example', 'it')
    RETURNING id
  `);
  const conversationId = ([...conversations][0] as { id: string }).id;

  await admin.execute(sql`
    INSERT INTO messages (tenant_id, conversation_id, role, content)
    VALUES (${id}::uuid, ${conversationId}::uuid, 'USER', 'qualcosa per una bistecca')
  `);
  await admin.execute(sql`
    INSERT INTO widget_events (tenant_id, session_id, type) VALUES (${id}::uuid, 's', 'WIDGET_OPEN')
  `);
  await admin.execute(sql`
    INSERT INTO usage_events (tenant_id, period, kind, cost_micros)
    VALUES (${id}::uuid, to_char(now(), 'YYYYMM'), 'chat_message', 12)
  `);
  await admin.execute(sql`
    INSERT INTO audit_log (tenant_id, action) VALUES (${id}::uuid, 'domain.verified')
  `);
  await admin.execute(sql`
    INSERT INTO security_events (tenant_id, type) VALUES (${id}::uuid, 'UNAUTHORIZED_ORIGIN')
  `);
  await admin.execute(sql`
    INSERT INTO widget_keys (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4)
    VALUES (${id}::uuid, ${`pk_${randomUUID().replaceAll('-', '')}`}, ${`argon2-hash-of-the-secret-${id}`}, 'sk_l', 'wxyz')
  `);
  await admin.execute(sql`
    INSERT INTO e_invoices (tenant_id, stripe_object_id, source, amount_cents, currency, paid_at, status)
    VALUES (${id}::uuid, ${`in_${randomUUID()}`}, 'invoice', 2900, 'eur', now(), 'issued')
  `);

  return { id, owner };
};

const rowsFor = async (tenantId: string): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  const tables = await admin.transaction((tx) => tenantTables(tx));

  for (const table of tables) {
    const rows = await admin.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}::uuid`,
    );

    counts[table] = ([...rows][0] as { n: number }).n;
  }

  return counts;
};

describe('the export', () => {
  it('holds every table the winery has rows in, and nothing from another winery', async () => {
    const mine = await winery('export-mine');
    const theirs = await winery('export-theirs');

    const archive = await withTenant(mine.id, (tx) => readTenantExport(tx, mine.id), runtime);
    const had = await rowsFor(mine.id);

    expect(archive).toBeDefined();

    /* Every table with a row for this winery is in the archive, with that many rows. */
    for (const [table, count] of Object.entries(had)) {
      if (table in NOT_EXPORTED) continue;

      expect(archive?.tables[table]?.length, table).toBe(count);
    }

    /* And every table the catalogue knows is there, empty or not, so an empty one is not a missing one. */
    expect(Object.keys(archive?.tables ?? {}).sort()).toEqual(
      Object.keys(had)
        .filter((table) => !(table in NOT_EXPORTED))
        .sort(),
    );

    const everything = JSON.stringify(archive);

    expect(everything).not.toContain(theirs.id);
    expect(everything).not.toContain(theirs.owner);
    expect(archive?.tenant).toMatchObject({ id: mine.id, name: 'export-mine srl' });
    expect(archive?.members).toEqual([
      expect.objectContaining({ id: mine.owner, name: 'Giulia', role: 'OWNER' }),
    ]);
  });

  it('carries no credential: not a key’s hash, nor any piece of the key', async () => {
    const mine = await winery('export-credentials');

    const archive = await withTenant(mine.id, (tx) => readTenantExport(tx, mine.id), runtime);
    const keys = archive?.tables.widget_keys ?? [];

    expect(keys).toHaveLength(1);

    for (const rows of Object.values(archive?.tables ?? {})) {
      for (const row of rows) {
        for (const column of OMITTED_COLUMNS) expect(row, column).not.toHaveProperty(column);
      }
    }

    expect(JSON.stringify(archive)).not.toContain('argon2-hash-of-the-secret');
    expect(keys[0]).not.toHaveProperty('secret_key_hash');
    expect(keys[0]).not.toHaveProperty('secret_key_prefix');
    expect(keys[0]).not.toHaveProperty('secret_key_last4');
    /* Nor anybody's session or password: the members are who and in what role. */
    expect(Object.keys(archive?.members[0] ?? {}).sort()).toEqual([
      'created_at',
      'email',
      'id',
      'name',
      'role',
    ]);
  });

  /**
   * The list is only as good as its coverage, so the catalogue is asked: every
   * column of a winery's tables whose name says credential is on it, and every
   * name on it is a column that exists — a rename would otherwise leave the
   * list guarding nothing.
   */
  it('leaves out every credential-shaped column the catalogue has, and names no column that is not there', async () => {
    /* Named, each with its reason, because each looks like a credential and is not. */
    const notCredentials = new Set([
      'content_hash', // a product's text, hashed to know when to re-embed it
      'request_hash', // an import's body, hashed to know a retry from a new import
      'visitor_hash', // a shopper, salted and rotated (§3.9): the winery's data about its visitors
      'input_tokens', // counts of a model's tokens, not tokens that let anybody in
      'output_tokens',
      'tokens_in',
      'tokens_out',
    ]);

    const columns = await admin.transaction(async (tx) => {
      const tables = await tenantTables(tx);
      const rows = await tx.execute(sql`
        SELECT DISTINCT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN (${sql.join(
          [...tables, 'tenants'].map((table) => sql`${table}`),
          sql`, `,
        )})
      `);

      return [...rows].map((row) => (row as { column_name: string }).column_name);
    });

    const shaped = columns.filter(
      (column) => /hash|token|nonce|secret|password/u.test(column) && !notCredentials.has(column),
    );

    expect(shaped.length).toBeGreaterThan(0);

    for (const column of shaped) expect(OMITTED_COLUMNS.has(column), column).toBe(true);
    for (const column of OMITTED_COLUMNS) expect(columns, column).toContain(column);
  });

  it('is fenced by its own WHERE as well as the policy: past row security, still one winery', async () => {
    const mine = await winery('export-fenced');
    const theirs = await winery('export-fenced-theirs');

    /* The superuser bypasses RLS, so only the export's own WHERE stands between the wineries. */
    const archive = await admin.transaction((tx) => readTenantExport(tx, mine.id));
    const everything = JSON.stringify(archive);

    expect(everything).not.toContain(theirs.id);
    expect(everything).not.toContain(theirs.owner);
    expect(archive?.tables.products).toHaveLength(1);
  });

  it('is nothing for a winery that is not there', async () => {
    const nobody = randomUUID();

    expect(await withTenant(nobody, (tx) => readTenantExport(tx, nobody), runtime)).toBeUndefined();
  });

  it('is written in the winery’s own audit log, as a count and never the contents', async () => {
    const mine = await winery('export-recorded');

    await withTenant(mine.id, (tx) => recordExport(tx, mine.id, 9), runtime);

    const recorded = await admin.execute(sql`
      SELECT action, metadata, actor_user_id FROM audit_log
      WHERE tenant_id = ${mine.id}::uuid AND action = 'tenant.exported'
    `);

    expect([...recorded]).toEqual([
      { action: 'tenant.exported', metadata: { rows: 9 }, actor_user_id: null },
    ]);
  });
});

describe('the erasure', () => {
  it('in a dry run, says what would go and takes nothing', async () => {
    const mine = await winery('erase-dry');
    const before = await rowsFor(mine.id);

    const receipt = await eraseTenant(migrate, mine.id);

    expect(receipt).toMatchObject({ dryRun: true, chargesKept: 1, accountsErased: 1 });
    expect(receipt.rows).toEqual(before);
    expect(await rowsFor(mine.id)).toEqual(before);
  });

  it('names the shops still connected, whose tokens are not in the database, and not one already gone', async () => {
    const mine = await winery('erase-shops');
    const shop = (name: string) => `${name}-${mine.id.slice(0, 8)}.myshopify.com`;

    await admin.execute(sql`
      INSERT INTO shopify_installations (tenant_id, shop, scopes, uninstalled_at) VALUES
        (${mine.id}::uuid, ${shop('connected')}, 'read_products', NULL),
        (${mine.id}::uuid, ${shop('removed')}, 'read_products', now())
    `);

    expect((await eraseTenant(migrate, mine.id)).shopsConnected).toEqual([shop('connected')]);
  });

  it('takes everything the winery had, in every table, and leaves another winery as it was', async () => {
    const mine = await winery('erase-mine');
    const theirs = await winery('erase-theirs');
    const theirsBefore = await rowsFor(theirs.id);

    const receipt = await eraseTenant(migrate, mine.id, { dryRun: false });

    expect(receipt.dryRun).toBe(false);
    expect(receipt.rows.products).toBe(1);
    expect(receipt.rows.audit_log).toBe(1);

    const left = await rowsFor(mine.id);

    expect(Object.values(left).every((count) => count === 0)).toBe(true);
    expect([
      ...(await admin.execute(sql`SELECT 1 FROM tenants WHERE id = ${mine.id}::uuid`)),
    ]).toEqual([]);
    expect(await rowsFor(theirs.id)).toEqual(theirsBefore);
  });

  it('keeps the charges, detached, with the buyer on them', async () => {
    const mine = await winery('erase-charges');

    await eraseTenant(migrate, mine.id, { dryRun: false });

    const kept = await admin.execute(sql`
      SELECT tenant_id, buyer_name, buyer_vat_id, buyer_sdi_code, buyer_kept_at, amount_cents, status
      FROM e_invoices WHERE buyer_name = 'erase-charges srl'
    `);

    expect([...kept]).toEqual([
      {
        tenant_id: null,
        buyer_name: 'erase-charges srl',
        buyer_vat_id: '12345678901',
        buyer_sdi_code: 'ABC1234',
        buyer_kept_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} /u) as string,
        amount_cents: '2900',
        status: 'issued',
      },
    ]);
  });

  it('erases a member who belonged only here, and keeps one who belongs elsewhere too', async () => {
    const shared = `user_${randomUUID()}`;
    const mine = await winery('erase-members', shared);
    const elsewhere = await winery('erase-elsewhere');

    await admin.execute(sql`
      INSERT INTO memberships (tenant_id, user_id, role) VALUES (${elsewhere.id}::uuid, ${shared}, 'EDITOR')
    `);

    const only = `user_${randomUUID()}`;

    await admin.execute(
      sql`INSERT INTO auth_users (id, name, email) VALUES (${only}, 'Marco', ${`${only}@example.test`})`,
    );
    await admin.execute(
      sql`INSERT INTO memberships (tenant_id, user_id, role) VALUES (${mine.id}::uuid, ${only}, 'EDITOR')`,
    );

    const receipt = await eraseTenant(migrate, mine.id, { dryRun: false });
    const users = async (id: string) =>
      [...(await admin.execute(sql`SELECT id FROM auth_users WHERE id = ${id}`))].length;

    expect(receipt).toMatchObject({ accountsErased: 1, accountsKept: 1 });
    expect(await users(only)).toBe(0);
    expect(await users(shared)).toBe(1);

    const memberships = await admin.execute(
      sql`SELECT tenant_id FROM memberships WHERE user_id = ${shared}`,
    );

    expect([...memberships]).toEqual([{ tenant_id: elsewhere.id }]);
  });

  it('refuses while a subscription is live, and while an invoice is still owed, and erases nothing', async () => {
    const subscribed = await winery('erase-subscribed');

    await admin.execute(sql`
      UPDATE tenants SET status = 'ACTIVE', plan = 'CANTINA',
        stripe_customer_id = ${`cus_${randomUUID()}`}, stripe_subscription_id = ${`sub_${randomUUID()}`}
      WHERE id = ${subscribed.id}::uuid
    `);

    const owed = await winery('erase-owed');

    await admin.execute(sql`
      INSERT INTO e_invoices (tenant_id, stripe_object_id, source, amount_cents, currency, paid_at)
      VALUES (${owed.id}::uuid, ${`in_${randomUUID()}`}, 'top_up', 500, 'eur', now())
    `);

    for (const [id, words] of [
      [subscribed.id, /Cancel it in Stripe first/u],
      [owed.id, /1 charges still waiting for their invoice/u],
    ] as const) {
      const before = await rowsFor(id);

      await expect(eraseTenant(migrate, id, { dryRun: false })).rejects.toThrow(words);
      await expect(eraseTenant(migrate, id, { dryRun: false })).rejects.toBeInstanceOf(
        ErasureRefusedError,
      );
      expect(await rowsFor(id)).toEqual(before);
    }
  });

  it('cannot be run as the runtime role, and leaves the winery whole when it fails part-way', async () => {
    const mine = await winery('erase-runtime');
    const before = await rowsFor(mine.id);

    /* The buyer is copied onto the charges first; the delete after it is refused (0029); the copy goes back too. */
    await expect(eraseTenant(runtime, mine.id, { dryRun: false })).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    expect(await rowsFor(mine.id)).toEqual(before);
    expect([
      ...(await admin.execute(
        sql`SELECT buyer_kept_at FROM e_invoices WHERE tenant_id = ${mine.id}::uuid`,
      )),
    ]).toEqual([{ buyer_kept_at: null }]);
  });

  it('refuses a winery that is not there', async () => {
    await expect(eraseTenant(migrate, randomUUID(), { dryRun: false })).rejects.toThrow(
      /There is no winery/u,
    );
  });

  it('cannot detach a charge without its buyer: the CHECK makes the copy part of the erasure', async () => {
    const mine = await winery('erase-check');

    /* The order `eraseTenant` refuses to get wrong, got wrong on purpose. */
    await expect(
      admin.execute(sql`DELETE FROM tenants WHERE id = ${mine.id}::uuid`),
    ).rejects.toMatchObject({ cause: { constraint_name: 'e_invoices_detached_keeps_buyer' } });
    expect((await rowsFor(mine.id)).e_invoices).toBe(1);
  });

  it('fails, and erases nothing, when a table with a tenant_id does not let go of the winery', async () => {
    const mine = await winery('erase-stray');
    const before = await rowsFor(mine.id);

    /* Next year's table, added without a foreign key: the cascade never reaches it. */
    await migrate.execute(sql`CREATE TABLE stray_tenant_rows (tenant_id uuid NOT NULL)`);

    try {
      await migrate.execute(sql`INSERT INTO stray_tenant_rows VALUES (${mine.id}::uuid)`);

      await expect(eraseTenant(migrate, mine.id, { dryRun: false })).rejects.toThrow(
        /stray_tenant_rows still holds 1 rows for this winery after its erasure; nothing was erased/u,
      );
      expect(await rowsFor(mine.id)).toEqual({ ...before, stray_tenant_rows: 1 });
    } finally {
      await migrate.execute(sql`DROP TABLE stray_tenant_rows`);
    }
  });
});

/**
 * The scripts, run as an operator runs them: a child process, its arguments,
 * its environment and what is typed at its prompt. What the functions do is
 * proved above; this is that the scripts call them that way.
 */
describe('the scripts', () => {
  const ROOT = resolve(import.meta.dirname, '..', '..', '..');
  const run = (script: string, args: string[], env: Record<string, string>, input = '') =>
    spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      timeout: 60_000,
    });
  const scratch = () => mkdtempSync(join(tmpdir(), 'tenant-scripts-'));

  it('exports a winery, as the runtime role, to the directory asked for, and records it', async () => {
    const mine = await winery('script-export');
    const out = scratch();

    try {
      const result = run('tenant-export.mjs', ['--tenant', mine.id, '--out', out], {
        DATABASE_URL: urls.runtime,
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
        tables: Record<string, number>;
      };

      expect(manifest.tables).toMatchObject({ products: 1, messages: 1, e_invoices: 1 });
      expect(readFileSync(join(out, 'tables', 'products.csv'), 'utf8')).toContain('Barolo');

      const recorded = await admin.execute(sql`
        SELECT metadata FROM audit_log WHERE tenant_id = ${mine.id}::uuid AND action = 'tenant.exported'
      `);
      const total = Object.values(manifest.tables).reduce((sum, count) => sum + count, 0);

      expect([...recorded]).toEqual([{ metadata: { rows: total } }]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('erases nothing without --execute, nor with it and the wrong slug, and erases on the right one', async () => {
    const mine = await winery('script-erase');
    const before = await rowsFor(mine.id);
    const slug = `script-erase-${mine.id}`;
    const env = { ERASURE_DATABASE_URL: urls.migrate };
    const out = scratch();

    try {
      const dry = run('tenant-delete.mjs', ['--tenant', mine.id, '--out', out], env, `${slug}\n`);

      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain('Dry run: nothing was erased');
      expect(await rowsFor(mine.id)).toEqual(before);

      const wrong = run(
        'tenant-delete.mjs',
        ['--tenant', mine.id, '--execute', '--out', out],
        env,
        `${slug.toUpperCase()}\n`,
      );

      expect(wrong.status).toBe(1);
      expect(wrong.stdout).toContain('That is not the slug. Nothing was erased.');
      expect(await rowsFor(mine.id)).toEqual(before);

      const right = run(
        'tenant-delete.mjs',
        ['--tenant', mine.id, '--execute', '--out', out],
        env,
        `${slug}\n`,
      );

      expect(right.stderr).toBe('');
      expect(right.status).toBe(0);
      expect(Object.values(await rowsFor(mine.id)).every((count) => count === 0)).toBe(true);

      const receipt = JSON.parse(
        readFileSync(join(out, `${mine.id}-erasure-receipt.json`), 'utf8'),
      ) as Record<string, unknown>;

      expect(receipt).toMatchObject({ tenantId: mine.id, slug, dryRun: false, chargesKept: 1 });
      expect(receipt.erasedAt).toEqual(expect.any(String));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
