import { randomUUID } from 'node:crypto';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { recordTurn, type TurnToRecord } from '../src/conversations.js';
import { countUsage, recordUsage } from '../src/usage.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';

/**
 * The usage ledger, against real Postgres (P2-31, P0-30).
 *
 * **The assertion the row is actually about is the transaction.** Usage and
 * history have to agree, and the only way they can disagree is if one is
 * written without the other — so the case that matters is a turn that fails
 * after both statements and leaves neither.
 *
 * The second is the grant. `usage_events` is append-only for `app_rw` (P0-31),
 * which means a correction is another row and a mistake cannot be tidied away.
 * That is a property of the database, so it is asserted against one.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

/*
 * Written out rather than imported from `packages/core`, which this package
 * cannot reach: core depends on db, so the arrow only points one way. What is
 * under test here is the writer; the price table and the period format are
 * asserted in `packages/core/test/usage.test.ts`, and 180 micros is what that
 * suite computes for these token counts.
 */
const CHAT_MESSAGE = 'chat_message';
const NOVA_LITE_COST_MICROS = 180;

const now = new Date();
const PERIOD = `${String(now.getUTCFullYear())}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

const turn = (sessionId: string): TurnToRecord => ({
  sessionId,
  origin: 'https://winery.example',
  visitorHash: null,
  locale: 'it',
  question: 'qualcosa per una bistecca',
  reply: 'Le consiglio un Barolo.',
  retrievedProductIds: [],
  model: 'amazon.nova-lite-v1:0',
  inputTokens: 1000,
  outputTokens: 500,
  latencyMs: 2400,
});

const ledger = async () =>
  [
    ...(await db.execute(sql`
      select kind, session_id, input_tokens, output_tokens, cost_micros
      from usage_events
      where tenant_id = ${tenantId}::uuid
      order by created_at
    `)),
  ] as {
    kind: string;
    session_id: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cost_micros: string | number | null;
  }[];

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  tenantId = await createTenant(db, 'usage');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await useTenant(db, tenantId);
  await db.execute(sql`delete from messages where tenant_id = ${tenantId}::uuid`);
});

describe('recording what a turn cost', () => {
  it('writes the counts and the cost the price table gives', async () => {
    const session = `sess-${randomUUID()}`;

    await withTenant(
      tenantId,
      (tx) =>
        recordUsage(tx, {
          period: PERIOD,
          kind: CHAT_MESSAGE,
          sessionId: session,
          inputTokens: 1000,
          outputTokens: 500,
          costMicros: NOVA_LITE_COST_MICROS,
        }),
      db,
    );

    const rows = await ledger();

    expect(rows.at(-1)).toMatchObject({
      kind: CHAT_MESSAGE,
      session_id: session,
      input_tokens: 1000,
      output_tokens: 500,
    });
    expect(Number(rows.at(-1)?.cost_micros)).toBe(NOVA_LITE_COST_MICROS);
  });

  it('writes the turn and the bill in one transaction', async () => {
    /*
     * The row's requirement, and the only way it can be checked: roll the
     * transaction back after both statements and assert that *neither* landed.
     * Written separately, a crash between them leaves a conversation nobody was
     * billed for, or a bill for a conversation that does not exist.
     */
    const session = `sess-${randomUUID()}`;
    const before = await withTenant(tenantId, (tx) => countUsage(tx, PERIOD, CHAT_MESSAGE), db);

    await expect(
      withTenant(
        tenantId,
        async (tx) => {
          await recordTurn(tx, turn(session));
          await recordUsage(tx, {
            period: PERIOD,
            kind: CHAT_MESSAGE,
            sessionId: session,
            inputTokens: 1000,
            outputTokens: 500,
            costMicros: 180,
          });

          throw new Error('the stream died after both writes');
        },
        db,
      ),
    ).rejects.toThrow('the stream died');

    const messages = [
      ...(await db.execute(sql`
        select 1 from messages m
        join conversations c on c.id = m.conversation_id
        where c.session_id = ${session}
      `)),
    ];

    expect(messages).toEqual([]);
    expect(await withTenant(tenantId, (tx) => countUsage(tx, PERIOD, CHAT_MESSAGE), db)).toBe(
      before,
    );
  });

  it('bills a turn whose model errored after it was called', async () => {
    /*
     * The tokens were spent whether or not the answer arrived. A failure loop
     * that costs the tenant nothing and us everything is the shape of every
     * runaway bill — so the row is written, and P2-30's turn beside it carries
     * the reply that never came.
     */
    const session = `sess-${randomUUID()}`;

    await withTenant(
      tenantId,
      async (tx) => {
        await recordTurn(tx, { ...turn(session), reply: '' });
        await recordUsage(tx, {
          period: PERIOD,
          kind: CHAT_MESSAGE,
          sessionId: session,
          inputTokens: 1000,
          outputTokens: 0,
          costMicros: 60,
        });
      },
      db,
    );

    const rows = await ledger();

    expect(rows.at(-1)).toMatchObject({ session_id: session, output_tokens: 0 });
  });

  it('counts messages rather than tokens, which is the unit a seller understands', async () => {
    const before = await withTenant(tenantId, (tx) => countUsage(tx, PERIOD, CHAT_MESSAGE), db);

    for (let message = 0; message < 3; message += 1) {
      await withTenant(
        tenantId,
        (tx) =>
          recordUsage(tx, {
            period: PERIOD,
            kind: CHAT_MESSAGE,
            sessionId: `sess-${randomUUID()}`,
            inputTokens: 100_000,
            outputTokens: 50_000,
            costMicros: 18_000,
          }),
        db,
      );
    }

    expect(await withTenant(tenantId, (tx) => countUsage(tx, PERIOD, CHAT_MESSAGE), db)).toBe(
      before + 3,
    );
  });

  it('counts only this period', async () => {
    // The period rolls over and the allowance resets. A count that ignored it
    // would refuse a tenant in February for what they spent in January.
    const last = '202001';

    await withTenant(
      tenantId,
      (tx) =>
        recordUsage(tx, {
          period: last,
          kind: CHAT_MESSAGE,
          sessionId: null,
          inputTokens: 1,
          outputTokens: 1,
          costMicros: 1,
        }),
      db,
    );

    expect(await withTenant(tenantId, (tx) => countUsage(tx, last, CHAT_MESSAGE), db)).toBe(1);
    expect(await withTenant(tenantId, (tx) => countUsage(tx, PERIOD, CHAT_MESSAGE), db)).not.toBe(
      1,
    );
  });

  it('counts only this kind', async () => {
    const before = await withTenant(tenantId, (tx) => countUsage(tx, PERIOD, CHAT_MESSAGE), db);

    await withTenant(
      tenantId,
      (tx) =>
        recordUsage(tx, {
          period: PERIOD,
          kind: 'embedding',
          sessionId: null,
          inputTokens: 900,
          outputTokens: null,
          costMicros: 18,
        }),
      db,
    );

    expect(await withTenant(tenantId, (tx) => countUsage(tx, PERIOD, CHAT_MESSAGE), db)).toBe(
      before,
    );
  });

  it('cannot see another tenant usage', async () => {
    const other = await createTenant(db, 'usage-other');

    await withTenant(
      other,
      (tx) =>
        recordUsage(tx, {
          period: PERIOD,
          kind: CHAT_MESSAGE,
          sessionId: null,
          inputTokens: 1,
          outputTokens: 1,
          costMicros: 1,
        }),
      db,
    );
    await useTenant(db, tenantId);

    const mine = await withTenant(tenantId, (tx) => countUsage(tx, PERIOD, CHAT_MESSAGE), db);
    const theirs = await withTenant(other, (tx) => countUsage(tx, PERIOD, CHAT_MESSAGE), db);

    expect(theirs).toBe(1);
    expect(mine).not.toBe(theirs);
  });
});

describe('the ledger a correction cannot be tidied into', () => {
  it('refuses an update from the runtime role', async () => {
    // P0-31 revokes UPDATE and DELETE on `usage_events` from `app_rw`. A bill
    // somebody can edit is a bill nobody can audit.
    await withTenant(
      tenantId,
      (tx) =>
        recordUsage(tx, {
          period: PERIOD,
          kind: CHAT_MESSAGE,
          sessionId: null,
          inputTokens: 1,
          outputTokens: 1,
          costMicros: 1,
        }),
      db,
    );

    await expect(
      db.execute(sql`update usage_events set cost_micros = 0 where tenant_id = ${tenantId}::uuid`),
    ).rejects.toThrow();
  });

  it('refuses a delete from the runtime role', async () => {
    await expect(
      db.execute(sql`delete from usage_events where tenant_id = ${tenantId}::uuid`),
    ).rejects.toThrow();
  });

  it('refuses a period written in any other shape', async () => {
    // The quota lookup is an equality on this column, so a row written as
    // `2026-09` is invisible to it — and a quota that finds nothing fails open.
    await expect(
      withTenant(
        tenantId,
        (tx) =>
          recordUsage(tx, {
            period: '2026-09',
            kind: CHAT_MESSAGE,
            sessionId: null,
            inputTokens: 1,
            outputTokens: 1,
            costMicros: 1,
          }),
        db,
      ),
    ).rejects.toThrow();
  });
});
