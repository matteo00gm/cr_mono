import { sql, type SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { normalisedQuestion } from '../src/top.js';
import { readZeroResults } from '../src/zero-results.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The unanswered questions, without a database (P6-04). What they count is
 * real SQL and lives in `zero-results.integration.test.ts`; what is held here
 * is what the statement says and how a row is read back.
 */

const fakeTx = (rows: unknown[] = []) => {
  const execute = vi.fn<(statement: SQL) => Promise<unknown[]>>(() => Promise.resolve(rows));
  return { execute, tx: { execute } as unknown as DbTransaction };
};

const RANGE = {
  start: new Date('2026-09-01T00:00:00.000Z'),
  end: new Date('2026-09-08T00:00:00.000Z'),
};

const statementOf = (fake: ReturnType<typeof fakeTx>): string => {
  const statement = fake.execute.mock.calls[0]?.[0];
  if (statement === undefined) throw new Error('no statement issued');
  return text(statement);
};

describe('readZeroResults', () => {
  it('reads each row back as a question, its conversations, both kinds and a moment', async () => {
    const fake = fakeTx([
      {
        question: 'avete un passito?',
        conversation_ids: ['c-1', 'c-2'],
        no_match: '1',
        not_recommended: 1,
        last_asked_at: '2026-09-05 08:00:00+00',
      },
    ]);

    expect(await readZeroResults(fake.tx, RANGE)).toEqual([
      {
        question: 'avete un passito?',
        conversationIds: ['c-1', 'c-2'],
        noMatch: 1,
        notRecommended: 1,
        lastAskedAt: new Date('2026-09-05T08:00:00.000Z'),
      },
    ]);
  });

  it('reads the answers that showed no wine, in the scope’s tenant', async () => {
    const fake = fakeTx();

    await readZeroResults(fake.tx, RANGE);

    const said = statementOf(fake);

    expect(said).toContain("a.role = 'ASSISTANT'");
    expect(said).toContain('a.zero_result_kind is not null');
    expect(said).toContain(
      "a.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid",
    );
  });

  it('pairs each with the question just before it in its conversation', async () => {
    const fake = fakeTx();

    await readZeroResults(fake.tx, RANGE);

    const said = statementOf(fake);

    expect(said).toContain('q.seq < a.seq');
    expect(said).toContain('order by q.seq desc');
  });

  it('groups by the same normalisation as the top questions', async () => {
    const fake = fakeTx();

    await readZeroResults(fake.tx, RANGE);

    expect(statementOf(fake)).toContain(text(normalisedQuestion(sql`question`)));
  });
});
