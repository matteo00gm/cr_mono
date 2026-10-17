import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { readServiceState } from '../src/billing.js';
import {
  countPurgeable,
  purgeConversations,
  purgeWidgetEvents,
  readTranscriptRetention,
} from '../src/retention.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The retention purge's statements without a database (P7-07): what each one
 * says and binds, and how its rows are read back. What they delete, and that
 * RLS keeps them to one winery, is `retention.integration.test.ts`'s.
 */

const fakeTx = (...answers: unknown[][]) => {
  const execute = vi.fn<(statement: SQL) => Promise<unknown[]>>(() =>
    Promise.resolve(answers.shift() ?? []),
  );

  return { execute, tx: { execute } as unknown as DbTransaction };
};

const issued = (fake: ReturnType<typeof fakeTx>): SQL => {
  const statement = fake.execute.mock.calls[0]?.[0];

  if (statement === undefined) throw new Error('No statement was issued.');

  return statement;
};

const bound = (fake: ReturnType<typeof fakeTx>): unknown[] =>
  new PgDialect().sqlToQuery(issued(fake)).params;

const said = (fake: ReturnType<typeof fakeTx>): string => text(issued(fake));

const BEFORE = new Date('2026-07-19T02:15:00.000Z');

describe('a winery’s chosen period', () => {
  it('is read from its own row', async () => {
    const fake = fakeTx([{ transcript_retention_days: 30 }]);

    expect(await readTranscriptRetention(fake.tx)).toBe(30);
    expect(said(fake)).toMatch(/SELECT transcript_retention_days FROM tenants LIMIT 1/u);
  });

  it('is null when it chose none, and when there is no row to read', async () => {
    expect(
      await readTranscriptRetention(fakeTx([{ transcript_retention_days: null }]).tx),
    ).toBeNull();
    expect(await readTranscriptRetention(fakeTx([]).tx)).toBeNull();
  });
});

describe('a batch of conversations', () => {
  it('is the oldest by their last message, up to the limit, and counted by what came back', async () => {
    const fake = fakeTx([{}, {}, {}]);

    expect(await purgeConversations(fake.tx, { before: BEFORE, limit: 500 })).toBe(3);
    expect(said(fake)).toMatch(/WHERE last_message_at <\s+::timestamptz/u);
    expect(said(fake)).toMatch(/ORDER BY last_message_at\s+LIMIT\s/u);
    expect(said(fake)).toMatch(/DELETE FROM conversations c USING doomed d WHERE c\.id = d\.id/u);
    expect(bound(fake)).toEqual([BEFORE.toISOString(), 500]);
  });
});

describe('a batch of widget events', () => {
  it('is the oldest by when they happened, up to the limit', async () => {
    const fake = fakeTx([{}]);

    expect(await purgeWidgetEvents(fake.tx, { before: BEFORE, limit: 2 })).toBe(1);
    expect(said(fake)).toMatch(/WHERE created_at <\s+::timestamptz/u);
    expect(said(fake)).toMatch(/DELETE FROM widget_events e USING doomed d WHERE e\.id = d\.id/u);
    expect(bound(fake)).toEqual([BEFORE.toISOString(), 2]);
  });
});

describe('the dry run’s count', () => {
  const events = new Date('2025-09-12T02:15:00.000Z');

  it('reads both counts by each table’s own cutoff', async () => {
    const fake = fakeTx([{ conversations: 4, events: 9 }]);

    expect(
      await countPurgeable(fake.tx, { conversationsBefore: BEFORE, eventsBefore: events }),
    ).toEqual({ conversations: 4, events: 9 });
    expect(bound(fake)).toEqual([BEFORE.toISOString(), events.toISOString()]);
  });

  it('is nought when there is no row to read', async () => {
    expect(
      await countPurgeable(fakeTx([]).tx, { conversationsBefore: BEFORE, eventsBefore: events }),
    ).toEqual({ conversations: 0, events: 0 });
  });
});

describe('the state the widget’s gates read (P2-37b)', () => {
  it('reads the four things, and the trial’s end as a date', async () => {
    const fake = fakeTx([
      {
        status: 'TRIALING',
        trial_ends_at: '2026-10-20T00:00:00.000Z',
        plan: null,
        locale: 'it',
      },
    ]);

    expect(await readServiceState(fake.tx)).toEqual({
      status: 'TRIALING',
      trialEndsAt: new Date('2026-10-20T00:00:00.000Z'),
      plan: null,
      locale: 'it',
    });
    expect(said(fake)).toMatch(/SELECT status, trial_ends_at, plan, locale\s+FROM tenants/u);
  });

  it('has no trial end for a winery that has none, and nothing for no row', async () => {
    expect(
      await readServiceState(
        fakeTx([{ status: 'ACTIVE', trial_ends_at: null, plan: 'CANTINA', locale: 'en' }]).tx,
      ),
    ).toEqual({ status: 'ACTIVE', trialEndsAt: null, plan: 'CANTINA', locale: 'en' });
    expect(await readServiceState(fakeTx([]).tx)).toBeUndefined();
  });
});
