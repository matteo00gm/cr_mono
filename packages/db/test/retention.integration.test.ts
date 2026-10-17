import { randomUUID } from 'node:crypto';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import {
  countPurgeable,
  purgeConversations,
  purgeWidgetEvents,
  readTranscriptRetention,
} from '../src/retention.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';

/**
 * The retention purge's statements (P7-07), against Postgres and RLS.
 *
 * **Under `app_rw`, in a winery's own scope**, which is how the job runs them:
 * so "another winery's rows are untouched" is the policy's doing, not the
 * test's. The orchestration — which winery, which cutoff, how many passes, the
 * dry run — is `apps/worker/test/retention.test.ts`'s.
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

const NOW = new Date('2026-10-17T02:15:00Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

/** A conversation last active `days` ago, with two messages. Seeded as the owner, past RLS. */
const conversation = async (tenantId: string, days: number): Promise<string> => {
  const rows = await adminDb.execute(sql`
    INSERT INTO conversations (tenant_id, session_id, origin, locale, started_at, last_message_at)
    VALUES (${tenantId}::uuid, ${`s-${randomUUID()}`}, 'https://x.example', 'it',
            ${daysAgo(days + 1)}::timestamptz, ${daysAgo(days)}::timestamptz)
    RETURNING id
  `);
  const id = ([...rows][0] as { id: string }).id;

  await adminDb.execute(sql`
    INSERT INTO messages (tenant_id, conversation_id, role, content)
    VALUES (${tenantId}::uuid, ${id}::uuid, 'USER', 'qualcosa per una bistecca'),
           (${tenantId}::uuid, ${id}::uuid, 'ASSISTANT', 'Un Barolo.')
  `);

  return id;
};

const event = async (tenantId: string, days: number, conversationId?: string): Promise<void> => {
  await adminDb.execute(sql`
    INSERT INTO widget_events (tenant_id, session_id, conversation_id, type, created_at)
    VALUES (${tenantId}::uuid, 's', ${conversationId ?? null}::uuid, 'WIDGET_OPEN',
            ${daysAgo(days)}::timestamptz)
  `);
};

const counts = async (tenantId: string) => {
  const rows = await adminDb.execute(sql`
    SELECT
      (SELECT count(*)::int FROM conversations WHERE tenant_id = ${tenantId}::uuid) AS conversations,
      (SELECT count(*)::int FROM messages WHERE tenant_id = ${tenantId}::uuid) AS messages,
      (SELECT count(*)::int FROM widget_events WHERE tenant_id = ${tenantId}::uuid) AS events
  `);

  return [...rows][0] as { conversations: number; messages: number; events: number };
};

const before90 = new Date(daysAgo(90));
const before400 = new Date(daysAgo(400));

describe('purging transcripts', () => {
  it('takes the conversations quiet for longer than the period, with their messages, and keeps the rest', async () => {
    const winery = await createTenant(db, 'retention-transcripts');
    const old = await conversation(winery, 91);

    await conversation(winery, 89);
    await conversation(winery, 1);

    const deleted = await withTenant(
      winery,
      (tx) => purgeConversations(tx, { before: before90, limit: 100 }),
      db,
    );

    expect(deleted).toBe(1);
    expect(await counts(winery)).toMatchObject({ conversations: 2, messages: 4 });

    const gone = await adminDb.execute(
      sql`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${old}::uuid`,
    );

    expect(([...gone][0] as { n: number }).n).toBe(0);
  });

  it('goes by the last message, not the first: a conversation somebody came back to is kept', async () => {
    const winery = await createTenant(db, 'retention-returned');

    /* Started long ago, still talking yesterday. */
    await adminDb.execute(sql`
      INSERT INTO conversations (tenant_id, session_id, origin, locale, started_at, last_message_at)
      VALUES (${winery}::uuid, ${`s-${randomUUID()}`}, 'https://x.example', 'it',
              ${daysAgo(200)}::timestamptz, ${daysAgo(1)}::timestamptz)
    `);

    expect(
      await withTenant(
        winery,
        (tx) => purgeConversations(tx, { before: before90, limit: 100 }),
        db,
      ),
    ).toBe(0);
  });

  it('keeps the events of a purged conversation, which hold no words, with the link cut', async () => {
    const winery = await createTenant(db, 'retention-linked');
    const old = await conversation(winery, 120);

    await event(winery, 120, old);
    await withTenant(winery, (tx) => purgeConversations(tx, { before: before90, limit: 100 }), db);

    const rows = await adminDb.execute(
      sql`SELECT conversation_id FROM widget_events WHERE tenant_id = ${winery}::uuid`,
    );

    expect([...rows]).toEqual([{ conversation_id: null }]);
  });

  it('takes at most a batch, oldest first, and a batch that comes back short is the end', async () => {
    const winery = await createTenant(db, 'retention-batches');

    for (const days of [95, 130, 91, 300, 100]) await conversation(winery, days);

    const first = await withTenant(
      winery,
      (tx) => purgeConversations(tx, { before: before90, limit: 2 }),
      db,
    );
    const left = await adminDb.execute(sql`
      SELECT round(extract(epoch FROM (${NOW.toISOString()}::timestamptz - last_message_at)) / 86400)::int AS days
      FROM conversations WHERE tenant_id = ${winery}::uuid ORDER BY days
    `);

    expect(first).toBe(2);
    /* The two oldest went first: three hundred days and a hundred and thirty. */
    expect([...left].map((row) => (row as { days: number }).days)).toEqual([91, 95, 100]);
    expect(
      await withTenant(winery, (tx) => purgeConversations(tx, { before: before90, limit: 2 }), db),
    ).toBe(2);
    expect(
      await withTenant(winery, (tx) => purgeConversations(tx, { before: before90, limit: 2 }), db),
    ).toBe(1);
    expect(
      await withTenant(winery, (tx) => purgeConversations(tx, { before: before90, limit: 2 }), db),
    ).toBe(0);
  });

  it('reaches only the winery whose scope it runs in', async () => {
    const winery = await createTenant(db, 'retention-mine');
    const neighbour = await createTenant(db, 'retention-theirs');

    await conversation(winery, 200);
    await conversation(neighbour, 200);
    await event(neighbour, 500);

    await withTenant(
      winery,
      async (tx) => {
        await purgeConversations(tx, { before: before90, limit: 100 });
        await purgeWidgetEvents(tx, { before: before400, limit: 100 });
      },
      db,
    );

    expect(await counts(winery)).toMatchObject({ conversations: 0 });
    expect(await counts(neighbour)).toEqual({ conversations: 1, messages: 2, events: 1 });
  });

  it('reaches nothing outside a scope at all', async () => {
    const winery = await createTenant(db, 'retention-unscoped');

    await conversation(winery, 200);

    /* As `app_rw` with no winery set: the policy admits no row, so there is nothing to delete. */
    const deleted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);

      return purgeConversations(tx, { before: before90, limit: 100 });
    });

    expect(deleted).toBe(0);
    expect((await counts(winery)).conversations).toBe(1);
  });
});

describe('the cutoff itself', () => {
  it('keeps a conversation whose last message is exactly at it: older than, not as old as', async () => {
    const winery = await createTenant(db, 'retention-boundary');

    await adminDb.execute(sql`
      INSERT INTO conversations (tenant_id, session_id, origin, locale, started_at, last_message_at)
      VALUES (${winery}::uuid, ${`s-${randomUUID()}`}, 'https://x.example', 'it',
              ${daysAgo(91)}::timestamptz, ${before90.toISOString()}::timestamptz)
    `);

    expect(
      await withTenant(
        winery,
        (tx) => purgeConversations(tx, { before: before90, limit: 100 }),
        db,
      ),
    ).toBe(0);
  });
});

describe('purging widget events', () => {
  it('takes the events older than their horizon, a batch at a time, and keeps the rest', async () => {
    const winery = await createTenant(db, 'retention-events');

    for (const days of [401, 450, 399, 10]) await event(winery, days);

    expect(
      await withTenant(winery, (tx) => purgeWidgetEvents(tx, { before: before400, limit: 1 }), db),
    ).toBe(1);
    expect(
      await withTenant(
        winery,
        (tx) => purgeWidgetEvents(tx, { before: before400, limit: 100 }),
        db,
      ),
    ).toBe(1);
    expect((await counts(winery)).events).toBe(2);
  });
});

describe('the dry run’s count', () => {
  it('says what the purges would take, and takes nothing', async () => {
    const winery = await createTenant(db, 'retention-dry');

    await conversation(winery, 91);
    await conversation(winery, 92);
    await conversation(winery, 10);
    /* Started long ago and still talking: counted by its last message, as the purge goes by. */
    await adminDb.execute(sql`
      INSERT INTO conversations (tenant_id, session_id, origin, locale, started_at, last_message_at)
      VALUES (${winery}::uuid, ${`s-${randomUUID()}`}, 'https://x.example', 'it',
              ${daysAgo(300)}::timestamptz, ${daysAgo(1)}::timestamptz)
    `);
    await event(winery, 401);
    await event(winery, 30);
    /* Past the transcripts' cutoff and inside the events': an event is counted by its own. */
    await event(winery, 120);

    expect(
      await withTenant(
        winery,
        (tx) => countPurgeable(tx, { conversationsBefore: before90, eventsBefore: before400 }),
        db,
      ),
    ).toEqual({ conversations: 2, events: 1 });
    expect(await counts(winery)).toEqual({ conversations: 4, messages: 6, events: 3 });
  });
});

describe('a winery’s own period', () => {
  it('is null until it chooses one, and then is what it chose', async () => {
    const winery = await createTenant(db, 'retention-choice');

    expect(await withTenant(winery, readTranscriptRetention, db)).toBeNull();

    await adminDb.execute(
      sql`UPDATE tenants SET transcript_retention_days = 30 WHERE id = ${winery}::uuid`,
    );

    expect(await withTenant(winery, readTranscriptRetention, db)).toBe(30);
  });

  it.each([0, -1, 3651])('is never %i days', async (days) => {
    const winery = await createTenant(db, 'retention-bounds');

    await expect(
      adminDb.execute(
        sql`UPDATE tenants SET transcript_retention_days = ${days} WHERE id = ${winery}::uuid`,
      ),
    ).rejects.toMatchObject({ cause: { constraint_name: 'tenants_transcript_retention_range' } });
  });

  it.each([1, 3650])('may be %i days', async (days) => {
    const winery = await createTenant(db, 'retention-edge');

    await adminDb.execute(
      sql`UPDATE tenants SET transcript_retention_days = ${days} WHERE id = ${winery}::uuid`,
    );

    expect(await withTenant(winery, readTranscriptRetention, db)).toBe(days);
  });
});
