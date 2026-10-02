import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { readZeroResults } from '../src/zero-results.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The questions the catalogue could not answer, against real Postgres (P6-04).
 *
 * A week with one question asked three ways in three conversations, of both
 * kinds; a conversation that asked two unanswered questions; one whose first
 * question was answered and second was not; answers that showed a wine or
 * failed; the edges of the range; and a second winery asking the same.
 */

const START = new Date('2026-09-01T00:00:00.000Z');
const END = new Date('2026-09-08T00:00:00.000Z');
const IN_RANGE = '2026-09-03T12:00:00.000Z';

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const CHECK_VIOLATION = '23514';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;
let otherTenantId: string;
const conversations = new Map<string, string>();

const conversation = async (session: string): Promise<string> => {
  const rows = await db.execute(sql`
    insert into conversations (tenant_id, session_id, origin, locale)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${session},
            'https://cantina.example', 'it')
    on conflict (tenant_id, session_id) do update set last_message_at = now()
    returning id
  `);
  const id = String([...rows][0]?.id);

  conversations.set(session, id);
  return id;
};

/** A question and its answer, in one statement as `recordTurn` writes them. */
const turn = async (
  session: string,
  question: string,
  kind: 'no_match' | 'not_recommended' | null,
  at = IN_RANGE,
): Promise<void> => {
  const id = await conversation(session);

  await db.execute(sql`
    insert into messages (tenant_id, conversation_id, role, content, zero_result_kind, created_at)
    values
      (nullif(current_setting('app.tenant_id', true), '')::uuid, ${id}::uuid, 'USER',
       ${question}, null, ${at}::timestamptz),
      (nullif(current_setting('app.tenant_id', true), '')::uuid, ${id}::uuid, 'ASSISTANT',
       'Mi spiace.', ${kind}, ${at}::timestamptz)
  `);
};

const read = (scope = tenantId, start = START, end = END) =>
  withTenant(scope, (tx) => readZeroResults(tx, { start, end }), db);

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  otherTenantId = await createTenant(db, 'altra-zero');
  for (const session of ['o1', 'o2']) await turn(session, 'Avete un passito?', 'no_match');

  tenantId = await createTenant(db, 'zero');

  /* One question, three ways, three conversations, both kinds. */
  await turn('a', 'Avete un passito?', 'no_match');
  await turn('b', '  avete un PASSITO? ', 'no_match');
  await turn('c', 'Avete un passito?', 'not_recommended', '2026-09-05T08:00:00.000Z');

  /* A second unanswered question in the same conversation. */
  await turn('a', 'E un moscato?', 'no_match');

  /* Answered first, unanswered second: the answer is paired with its own question. */
  await turn('f', 'prima domanda', null);
  await turn('f', 'seconda domanda', 'no_match');

  /* An answer that showed a wine, and one that failed: neither is unanswered. */
  await turn('d', 'un rosso per la bistecca', null);
  await turn('e', 'ciao', null);

  /* The edges: the range is [start, end). */
  await turn('g', 'al primo istante', 'no_match', START.toISOString());
  await turn('h', 'dopo il periodo', 'no_match', END.toISOString());
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await useTenant(db, tenantId);
});

describe('readZeroResults', () => {
  it('groups each question however it was typed, with its conversations and both kinds', async () => {
    const [first] = await read();

    expect(first?.question).toBe('avete un passito?');
    expect([...(first?.conversationIds ?? [])].sort()).toEqual(
      ['a', 'b', 'c'].map((session) => conversations.get(session)).sort(),
    );
    expect(first?.noMatch).toBe(2);
    expect(first?.notRecommended).toBe(1);
    expect(first?.lastAskedAt).toEqual(new Date('2026-09-05T08:00:00.000Z'));
  });

  it('lists every unanswered question, and nothing that was answered or failed', async () => {
    expect((await read()).map(({ question }) => question).sort()).toEqual(
      ['al primo istante', 'avete un passito?', 'e un moscato?', 'seconda domanda'].sort(),
    );
  });

  it('pairs an answer with the question just before it, not the first in the conversation', async () => {
    const asked = (await read()).map(({ question }) => question);

    expect(asked).toContain('seconda domanda');
    expect(asked).not.toContain('prima domanda');
  });

  it('keeps a conversation’s second unanswered question as its own row', async () => {
    const moscato = (await read()).find(({ question }) => question === 'e un moscato?');

    expect(moscato?.conversationIds).toEqual([conversations.get('a')]);
  });

  it('lists the most asked first', async () => {
    expect((await read())[0]?.conversationIds).toHaveLength(3);
  });

  it('counts only [start, end)', async () => {
    const asked = (await read()).map(({ question }) => question);

    expect(asked).toContain('al primo istante');
    expect(asked).not.toContain('dopo il periodo');
  });

  it("is the scope's winery only", async () => {
    const mine = (await read()).find(({ question }) => question === 'avete un passito?');
    const theirs = await read(otherTenantId);

    expect(mine?.conversationIds).toHaveLength(3);
    expect(
      theirs.map(({ question, conversationIds }) => [question, conversationIds.length]),
    ).toEqual([['avete un passito?', 2]]);
  });
});

describe('the column', () => {
  it('refuses a kind it does not know', async () => {
    const id = conversations.get('d') ?? '';
    const error = await db
      .execute(
        sql`
        insert into messages (tenant_id, conversation_id, role, content, zero_result_kind)
        values (${tenantId}::uuid, ${id}::uuid, 'ASSISTANT', 'x', 'sold_out')
      `,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a kind on a question, which has no result to lack', async () => {
    const id = conversations.get('d') ?? '';
    const error = await db
      .execute(
        sql`
        insert into messages (tenant_id, conversation_id, role, content, zero_result_kind)
        values (${tenantId}::uuid, ${id}::uuid, 'USER', 'x', 'no_match')
      `,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});
