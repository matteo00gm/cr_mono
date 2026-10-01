import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { recordWidgetEvents, type EventBatch } from '../src/widget-events.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The analytics writer, without a database (P6-01).
 *
 * What the statement says and what it binds. What it *does* — a foreign
 * product nulled under the policy, the conversation found in scope, the batch
 * in one statement — is real SQL, and lives in
 * `widget-events-write.integration.test.ts`.
 */

/** A transaction whose `execute` answers with these rows. */
const fakeTx = (rows: unknown[] = []) => {
  const execute = vi.fn<(statement: SQL) => Promise<unknown[]>>(() => Promise.resolve(rows));
  return { execute, tx: { execute } as unknown as DbTransaction };
};

const BATCH: EventBatch = {
  visitorId: 'visitor-0001',
  widgetSessionId: 'session-1',
  events: [
    { type: 'WIDGET_OPEN', productId: null, at: new Date('2026-10-01T10:00:00.000Z') },
    { type: 'ADD_TO_CART', productId: 'p-1', at: new Date('2026-10-01T10:00:01.000Z') },
  ],
};

const statementOf = (fake: ReturnType<typeof fakeTx>): SQL => {
  const statement = fake.execute.mock.calls[0]?.[0];
  if (statement === undefined) throw new Error('no statement issued');
  return statement;
};

describe('recordWidgetEvents', () => {
  it('answers with how many rows the store returned', async () => {
    const fake = fakeTx([{ id: 'e-1' }, { id: 'e-2' }]);

    await expect(recordWidgetEvents(fake.tx, BATCH)).resolves.toBe(2);
    expect(fake.execute).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for an empty batch', async () => {
    const fake = fakeTx();

    await expect(recordWidgetEvents(fake.tx, { ...BATCH, events: [] })).resolves.toBe(0);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('takes the tenant from the scope, never from the batch', async () => {
    const fake = fakeTx();

    await recordWidgetEvents(fake.tx, BATCH);

    expect(text(statementOf(fake))).toContain("current_setting('app.tenant_id', true)");
  });

  it('joins the product under the policy, so a foreign one names nothing', async () => {
    const fake = fakeTx();

    await recordWidgetEvents(fake.tx, BATCH);

    expect(text(statementOf(fake))).toContain('LEFT JOIN products p ON p.id = e.product_id');
  });

  it('binds the batch as one parameter, with each event as the widget stamped it', async () => {
    const fake = fakeTx();

    await recordWidgetEvents(fake.tx, BATCH);

    const { params } = new PgDialect().sqlToQuery(statementOf(fake));

    expect(params).toContain(BATCH.visitorId);
    expect(params).toContain(BATCH.widgetSessionId);
    expect(params).toContain(
      JSON.stringify([
        { type: 'WIDGET_OPEN', product_id: null, at: '2026-10-01T10:00:00.000Z' },
        { type: 'ADD_TO_CART', product_id: 'p-1', at: '2026-10-01T10:00:01.000Z' },
      ]),
    );
  });
});
