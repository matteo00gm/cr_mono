import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { readFunnel } from '../src/funnel.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The funnel's statement, without a database (P6-02). What it counts is real
 * SQL and lives in `funnel.integration.test.ts`; what is held here is what it
 * says and what it binds.
 */

const fakeTx = (rows: unknown[] = []) => {
  const execute = vi.fn<(statement: SQL) => Promise<unknown[]>>(() => Promise.resolve(rows));
  return { execute, tx: { execute } as unknown as DbTransaction };
};

const QUERY = {
  stages: ['WIDGET_OPEN', 'MESSAGE_SENT'] as const,
  start: new Date('2026-09-01T00:00:00.000Z'),
  end: new Date('2026-09-08T00:00:00.000Z'),
};

const statementOf = (fake: ReturnType<typeof fakeTx>): SQL => {
  const statement = fake.execute.mock.calls[0]?.[0];
  if (statement === undefined) throw new Error('no statement issued');
  return statement;
};

describe('readFunnel', () => {
  it('answers each stage with its row, in order, as numbers', async () => {
    const fake = fakeTx([
      { stage: 1, sessions: 12 },
      { stage: 2, sessions: '5' },
    ]);

    await expect(readFunnel(fake.tx, QUERY)).resolves.toEqual([12, 5]);
    expect(fake.execute).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for no stages', async () => {
    const fake = fakeTx();

    await expect(readFunnel(fake.tx, { ...QUERY, stages: [] })).resolves.toEqual([]);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("reads the scope's tenant, on top of its policy", async () => {
    const fake = fakeTx();

    await readFunnel(fake.tx, QUERY);

    expect(text(statementOf(fake))).toContain(
      "tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid",
    );
  });

  it('reads only the stages, which is what lets the (tenant, type, time) index serve it', async () => {
    /*
     * Not a correctness filter: an event that is not a stage has no position,
     * and reaches nothing. It is what keeps the read on the index rather than
     * on every event a busy winery's visitors ever sent.
     */
    const fake = fakeTx();

    await readFunnel(fake.tx, QUERY);

    expect(text(statementOf(fake))).toContain('and type = any(');
  });

  it('counts a visit at its furthest stage, so the funnel cannot widen', async () => {
    const fake = fakeTx();

    await readFunnel(fake.tx, QUERY);

    expect(text(statementOf(fake))).toContain('left join furthest f on f.reached >= stage');
  });

  it('binds the stages as one array, and the range as its two instants', async () => {
    const fake = fakeTx();

    await readFunnel(fake.tx, QUERY);

    const { params } = new PgDialect().sqlToQuery(statementOf(fake));

    expect(params).toContain('{WIDGET_OPEN,MESSAGE_SENT}');
    expect(params).toContain('2026-09-01T00:00:00.000Z');
    expect(params).toContain('2026-09-08T00:00:00.000Z');
    expect(params).toContain(2);
  });
});
