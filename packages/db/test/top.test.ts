import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { normalisedQuestion, readTopProducts, readTopQueries } from '../src/top.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The top questions and wines, without a database (P6-03). What they count is
 * real SQL and lives in `top.integration.test.ts`; what is held here is what
 * the statements say, what they bind, and how a row is read back.
 */

const fakeTx = (rows: unknown[] = []) => {
  const execute = vi.fn<(statement: SQL) => Promise<unknown[]>>(() => Promise.resolve(rows));
  return { execute, tx: { execute } as unknown as DbTransaction };
};

const RANGE = {
  start: new Date('2026-09-01T00:00:00.000Z'),
  end: new Date('2026-09-08T00:00:00.000Z'),
};

const statementOf = (fake: ReturnType<typeof fakeTx>): SQL => {
  const statement = fake.execute.mock.calls[0]?.[0];
  if (statement === undefined) throw new Error('no statement issued');
  return statement;
};

describe('readTopQueries', () => {
  it('reads each row back as a question, a count and a moment', async () => {
    const fake = fakeTx([
      { query: 'prosecco?', conversations: '4', last_asked_at: '2026-09-03 12:00:00+00' },
    ]);

    expect(await readTopQueries(fake.tx, { ...RANGE, minConversations: 3, limit: 10 })).toEqual([
      {
        query: 'prosecco?',
        conversations: 4,
        lastAskedAt: new Date('2026-09-03T12:00:00.000Z'),
      },
    ]);
  });

  it("reads visitors' messages only, in the scope's tenant", async () => {
    const fake = fakeTx();

    await readTopQueries(fake.tx, { ...RANGE, minConversations: 3, limit: 10 });

    const said = text(statementOf(fake));

    expect(said).toContain("m.role = 'USER'");
    expect(said).toContain(
      "m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid",
    );
  });

  it('collapses whitespace with a class a template literal cannot eat', () => {
    expect(text(normalisedQuestion(sql`m.content`))).toMatch(
      /^lower\(btrim\(regexp_replace\( *m\.content *, '\[\[:space:\]\]\+', ' ', 'g'\)\)\)$/u,
    );
  });

  it('groups by that normalisation, which P6-04 shares', async () => {
    const fake = fakeTx();

    await readTopQueries(fake.tx, { ...RANGE, minConversations: 3, limit: 10 });

    expect(text(statementOf(fake))).toContain(text(normalisedQuestion(sql`m.content`)));
  });

  it('binds the threshold and the limit it is given', async () => {
    const fake = fakeTx();

    await readTopQueries(fake.tx, { ...RANGE, minConversations: 7, limit: 4 });

    const { params } = new PgDialect().sqlToQuery(statementOf(fake));

    expect(params).toEqual(expect.arrayContaining([7, 4, RANGE.start.toISOString()]));
  });
});

describe('readTopProducts', () => {
  it('reads a deleted wine as no name, and anything but true as not archived', async () => {
    const fake = fakeTx([
      { product_id: 'p-1', name: 'Barolo', archived: true, recommended: 3, added: '2' },
      { product_id: 'p-2', name: null, archived: false, recommended: 1, added: 0 },
    ]);

    expect(await readTopProducts(fake.tx, { ...RANGE, limit: 10 })).toEqual([
      { productId: 'p-1', name: 'Barolo', archived: true, recommended: 3, added: 2 },
      { productId: 'p-2', name: null, archived: false, recommended: 1, added: 0 },
    ]);
  });

  it('counts the cards, not the candidates, and the answers that showed them', async () => {
    const fake = fakeTx();

    await readTopProducts(fake.tx, { ...RANGE, limit: 10 });

    const said = text(statementOf(fake));

    expect(said).toContain('unnest(m.recommended_product_ids)');
    expect(said).not.toContain('retrieved_product_ids');
    expect(said).toContain("m.role = 'ASSISTANT'");
  });

  it('keeps a wine whatever became of it, by a left join', async () => {
    const fake = fakeTx();

    await readTopProducts(fake.tx, { ...RANGE, limit: 10 });

    expect(text(statementOf(fake))).toContain('left join products p on p.id = s.product_id');
  });

  it('binds the limit it is given', async () => {
    const fake = fakeTx();

    await readTopProducts(fake.tx, { ...RANGE, limit: 4 });

    expect(new PgDialect().sqlToQuery(statementOf(fake)).params).toContain(4);
  });
});
