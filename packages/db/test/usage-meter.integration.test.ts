import { randomUUID } from 'node:crypto';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { claimQuotaNotice, readUsageBreakdown } from '../src/usage.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';

/**
 * The month as a seller reads it, against real Postgres (P5-12): which quota
 * notices have gone out, and where the messages went.
 */

const CHAT_MESSAGE = 'chat_message';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let admin: DbClient | undefined;
let db: Database;
let adminDb: Database;
let tenantId: string;

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

beforeEach(async () => {
  tenantId = await createTenant(db, 'meter');
});

const claim = (tenant: string, period: string, threshold: 80 | 100) =>
  withTenant(tenant, (tx) => claimQuotaNotice(tx, period, threshold), db);

describe('claiming a quota notice', () => {
  it('is granted once per winery, period and threshold', async () => {
    expect(await claim(tenantId, '202610', 80)).toBe(true);
    expect(await claim(tenantId, '202610', 80)).toBe(false);
  });

  it('is granted again for the other threshold, the next month, and another winery', async () => {
    const other = await createTenant(db, 'meter-other');

    await claim(tenantId, '202610', 80);

    expect(await claim(tenantId, '202610', 100)).toBe(true);
    expect(await claim(tenantId, '202611', 80)).toBe(true);
    expect(await claim(other, '202610', 80)).toBe(true);
  });

  it('is granted to exactly one of two claims made together', async () => {
    const [first, second] = await Promise.all([
      claim(tenantId, '202610', 100),
      claim(tenantId, '202610', 100),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });
});

describe('where the month went', () => {
  /** A billed turn on `day`, asked from `origin` — or from no conversation at all. */
  const message = async (tenant: string, day: string, origin: string | null) => {
    const sessionId = `sess-${randomUUID()}`;

    if (origin !== null) {
      await adminDb.execute(sql`
        INSERT INTO conversations (tenant_id, session_id, origin, locale)
        VALUES (${tenant}::uuid, ${sessionId}, ${origin}, 'it')
      `);
    }

    await adminDb.execute(sql`
      INSERT INTO usage_events (tenant_id, period, kind, session_id, created_at)
      VALUES (${tenant}::uuid, '202610', ${CHAT_MESSAGE}, ${sessionId}, ${`${day}T12:00:00Z`}::timestamptz)
    `);
  };

  it('is told by day, oldest first, and by origin, busiest first', async () => {
    await message(tenantId, '2026-10-02', 'https://www.cantina.example');
    await message(tenantId, '2026-10-02', 'https://www.cantina.example');
    await message(tenantId, '2026-10-01', 'https://staging.cantina.example');
    await message(tenantId, '2026-10-03', null);

    expect(
      await withTenant(tenantId, (tx) => readUsageBreakdown(tx, '202610', CHAT_MESSAGE), db),
    ).toEqual({
      byDay: [
        { key: '2026-10-01', messages: 1 },
        { key: '2026-10-02', messages: 2 },
        { key: '2026-10-03', messages: 1 },
      ],
      byOrigin: [
        { key: 'https://www.cantina.example', messages: 2 },
        { key: '', messages: 1 },
        { key: 'https://staging.cantina.example', messages: 1 },
      ],
    });
  });

  it('counts only the scope’s own winery, and only the month asked for', async () => {
    const other = await createTenant(db, 'meter-elsewhere');

    await message(other, '2026-10-02', 'https://other.example');

    expect(
      await withTenant(tenantId, (tx) => readUsageBreakdown(tx, '202610', CHAT_MESSAGE), db),
    ).toEqual({ byDay: [], byOrigin: [] });
    expect(
      await withTenant(other, (tx) => readUsageBreakdown(tx, '202609', CHAT_MESSAGE), db),
    ).toEqual({ byDay: [], byOrigin: [] });
  });
});
