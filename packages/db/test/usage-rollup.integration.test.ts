import { randomUUID } from 'node:crypto';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { listTenantDirectory } from '../src/tenant-directory.js';
import { rollupUsageDay } from '../src/usage.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';

/**
 * The nightly rollup against real Postgres (P5-13): the ninth scope reads
 * every tenant and nothing else (ADR 0030), and a day recomputed from the
 * ledger matches a fixture worked out by hand, twice running.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let admin: DbClient | undefined;
let db: Database;
let adminDb: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
  admin = createDbClient(started.adminUrl, { max: 1 });
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await admin?.close();
  await container?.stop();
}, 60_000);

const daily = async (tenantId: string, day: string) => {
  const rows = await adminDb.execute(sql`
    SELECT messages, conversations, add_to_carts, tokens_in::int AS tokens_in,
           tokens_out::int AS tokens_out, cost_micros::int AS cost_micros
    FROM usage_daily WHERE tenant_id = ${tenantId}::uuid AND day = ${day}::date
  `);

  return [...rows];
};

/** `createTenant` leaves its tenant set on the session; these cases need none. */
const clearTenant = async () => {
  await db.execute(sql`SELECT set_config('app.tenant_id', '', false)`);
};

describe('the tenant directory (ADR 0030)', () => {
  it('lists every tenant, as app_rw, with no tenant set', async () => {
    const one = await createTenant(db, 'dir-one');
    const two = await createTenant(db, 'dir-two');

    const ids = (await listTenantDirectory(db)).map((entry) => entry.id);

    expect(ids).toEqual(expect.arrayContaining([one, two]));
  });

  it('leaves nothing visible once its transaction is over', async () => {
    await createTenant(db, 'dir-after');
    await clearTenant();
    await listTenantDirectory(db);

    const rows = await db.transaction((tx) => tx.execute(sql`SELECT id FROM tenants`));

    expect([...rows]).toEqual([]);
  });

  it('writes nothing even holding the flag, because WITH CHECK is the tenant’s', async () => {
    const victim = await createTenant(db, 'dir-victim');

    await clearTenant();

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_directory', 'on', true)`);
        await tx.execute(sql`UPDATE tenants SET name = 'taken' WHERE id = ${victim}::uuid`);
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('a day, rolled up', () => {
  const DAY = '2026-10-14';

  const seedDay = async (tenantId: string) => {
    const at = (time: string) => `${DAY}T${time}Z`;

    /* Three chat turns, one embedding, and a turn either side of the day. */
    await adminDb.execute(sql`
      INSERT INTO usage_events (tenant_id, period, kind, input_tokens, output_tokens, cost_micros, created_at)
      VALUES
        (${tenantId}::uuid, '202610', 'chat_message', 1000, 500, 180, ${at('00:00:00')}::timestamptz),
        (${tenantId}::uuid, '202610', 'chat_message', 2000, 300, 200, ${at('12:00:00')}::timestamptz),
        (${tenantId}::uuid, '202610', 'chat_message', 100, 50, 20, ${at('23:59:59')}::timestamptz),
        (${tenantId}::uuid, '202610', 'embedding', 400, null, 4, ${at('09:00:00')}::timestamptz),
        (${tenantId}::uuid, '202610', 'chat_message', 9, 9, 9, '2026-10-13T23:59:59Z'::timestamptz),
        (${tenantId}::uuid, '202610', 'chat_message', 9, 9, 9, '2026-10-15T00:00:00Z'::timestamptz)
    `);
    await adminDb.execute(sql`
      INSERT INTO conversations (tenant_id, session_id, origin, locale, started_at)
      VALUES (${tenantId}::uuid, ${`s-${randomUUID()}`}, 'https://x.example', 'it', ${at('10:00:00')}::timestamptz),
             (${tenantId}::uuid, ${`s-${randomUUID()}`}, 'https://x.example', 'it', '2026-10-13T10:00:00Z'::timestamptz)
    `);
    await adminDb.execute(sql`
      INSERT INTO widget_events (tenant_id, session_id, type, created_at)
      VALUES (${tenantId}::uuid, 's', 'ADD_TO_CART', ${at('11:00:00')}::timestamptz),
             (${tenantId}::uuid, 's', 'ADD_TO_CART', ${at('11:05:00')}::timestamptz),
             (${tenantId}::uuid, 's', 'WIDGET_OPEN', ${at('11:06:00')}::timestamptz)
    `);
  };

  /* Worked out by hand from the rows above: the day's own rows, nothing either side. */
  const EXPECTED = {
    messages: 3,
    conversations: 1,
    add_to_carts: 2,
    tokens_in: 3_500,
    tokens_out: 850,
    cost_micros: 404,
  };

  it('matches the hand-computed fixture', async () => {
    const tenantId = await createTenant(db, 'roll-fixture');

    await seedDay(tenantId);
    await withTenant(tenantId, (tx) => rollupUsageDay(tx, DAY), db);

    expect(await daily(tenantId, DAY)).toEqual([EXPECTED]);
  });

  it('recomputes rather than adds when run again', async () => {
    const tenantId = await createTenant(db, 'roll-twice');

    await seedDay(tenantId);
    await withTenant(tenantId, (tx) => rollupUsageDay(tx, DAY), db);
    await withTenant(tenantId, (tx) => rollupUsageDay(tx, DAY), db);

    expect(await daily(tenantId, DAY)).toEqual([EXPECTED]);
  });

  it('writes a row of noughts for a day with nothing, rather than a gap', async () => {
    const tenantId = await createTenant(db, 'roll-quiet');

    await withTenant(tenantId, (tx) => rollupUsageDay(tx, DAY), db);

    expect(await daily(tenantId, DAY)).toEqual([
      {
        messages: 0,
        conversations: 0,
        add_to_carts: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_micros: 0,
      },
    ]);
  });

  it('reads only the scope’s own tenant', async () => {
    const busy = await createTenant(db, 'roll-busy');
    const quiet = await createTenant(db, 'roll-neighbour');

    await seedDay(busy);
    await withTenant(quiet, (tx) => rollupUsageDay(tx, DAY), db);

    expect((await daily(quiet, DAY))[0]).toMatchObject({ messages: 0, cost_micros: 0 });
  });
});
