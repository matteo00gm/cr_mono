import { describe, expect, it, vi } from 'vitest';

import { readConversation, recordTurn, type TurnToRecord } from '../src/conversations.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The statements a turn issues (P2-30).
 *
 * What only a unit test can see: *how many* statements, and what the upsert
 * conflicts on. Both are asserted against real Postgres as behaviour in
 * `conversations.integration.test.ts` — but a turn that quietly became three
 * round trips would pass every one of those cases, and a chat request pays for
 * each one while a visitor waits.
 */

const text = (statement: unknown): string =>
  ((statement as { queryChunks?: unknown[] }).queryChunks ?? [])
    .flatMap((chunk): string[] => {
      if (typeof chunk !== 'object' || chunk === null) return [];
      if (Array.isArray((chunk as { value?: unknown[] }).value)) {
        return (chunk as { value: string[] }).value;
      }
      return 'queryChunks' in chunk ? [text(chunk)] : [];
    })
    .join(' ');

const capturing = (...responses: unknown[][]) => {
  const statements: unknown[] = [];
  let call = 0;
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    const rows = responses[call] ?? [];
    call += 1;

    return Promise.resolve(rows);
  });

  return { statements, tx: { execute } as unknown as DbTransaction };
};

const TURN: TurnToRecord = {
  sessionId: 'sess-1',
  origin: 'https://winery.example',
  visitorHash: null,
  locale: 'it',
  question: 'qualcosa per una bistecca',
  reply: 'Le consiglio un Barolo.',
  retrievedProductIds: [],
  model: 'amazon.nova-lite-v1:0',
  inputTokens: 1200,
  outputTokens: 180,
  latencyMs: 2400,
};

const opened = [{ id: '11111111-1111-1111-1111-111111111111', inserted: true }];

describe('recording a turn', () => {
  it('is two statements: the conversation, then both messages', async () => {
    /*
     * Counted here because only a unit test can count it. A turn that inserted
     * the question and the answer separately would be three round trips inside
     * the transaction a visitor is waiting on, and every integration case would
     * still pass.
     */
    const { statements, tx } = capturing(opened);

    await recordTurn(tx, TURN);

    expect(statements).toHaveLength(2);
    expect(text(statements[1])).toContain("'USER'");
    expect(text(statements[1])).toContain("'ASSISTANT'");
  });

  it('upserts on the pair a session is unique by', async () => {
    const { statements, tx } = capturing(opened);

    await recordTurn(tx, TURN);

    expect(text(statements[0])).toContain('on conflict (tenant_id, session_id) do update');
  });

  it('reads the tenant from the setting, never from the caller', async () => {
    // P0-48: a tenant is never an argument. It is whatever `withTenant` set,
    // which is what makes a wrong one impossible rather than merely unlikely.
    const { statements, tx } = capturing(opened);

    await recordTurn(tx, TURN);

    expect(text(statements[0])).toContain("current_setting('app.tenant_id'");
    expect(text(statements[1])).toContain("current_setting('app.tenant_id'");
  });

  it('reports whether the turn opened the conversation', async () => {
    // `xmax = 0` is true only for a row this statement inserted. §2.4 counts
    // sessions with it, and a value derived any other way would need a second
    // query and could disagree with the first.
    const { tx } = capturing([{ id: 'c1', inserted: false }]);

    await expect(recordTurn(tx, TURN)).resolves.toEqual({
      conversationId: 'c1',
      started: false,
    });
  });

  it('refuses to continue when the upsert returned nothing', async () => {
    // Unreachable through the policy rather than through a branch — and checked
    // anyway, because the alternative is a `!` that turns a policy change into
    // a crash three frames away with no mention of conversations.
    const { tx } = capturing([]);

    await expect(recordTurn(tx, TURN)).rejects.toThrow(/no conversation/);
  });
});

describe('reading a conversation back', () => {
  it('breaks the timestamp tie by role, so the question comes first', async () => {
    /*
     * Both messages of a turn are written in one statement and share `now()`.
     * Ordering by time alone can put the answer before the question — a history
     * in which the model spoke first, which is exactly the thing a model will
     * try to make sense of.
     */
    const { statements, tx } = capturing([]);

    await readConversation(tx, 'sess-1', 6);

    expect(text(statements[0])).toContain('order by m.created_at desc, m.role desc');
    expect(text(statements[0])).toContain('order by created_at, role');
  });

  it('is scoped to the tenant as well as the session', async () => {
    const { statements, tx } = capturing([]);

    await readConversation(tx, 'sess-1', 6);

    expect(text(statements[0])).toContain("current_setting('app.tenant_id'");
  });

  it('reads a missing id array as no candidates rather than as null', async () => {
    const { tx } = capturing([{ role: 'USER', content: 'ciao', retrieved_product_ids: null }]);

    await expect(readConversation(tx, 'sess-1', 6)).resolves.toEqual([
      { role: 'USER', content: 'ciao', retrievedProductIds: [] },
    ]);
  });
});
