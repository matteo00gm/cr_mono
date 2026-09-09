import { describe, expect, it, vi } from 'vitest';

import { claimWebhookEvent, withWebhookEvent } from '../src/webhooks.js';
import type { Database } from '../src/client.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The webhook ledger's statements, without a database (P0-64b).
 *
 * Shapes and branches only, and the boundary with the integration file is worth
 * stating because it is the same one `rate-limit.test.ts` draws. **Whether the
 * claim and the effect really commit together cannot be asserted here** — a
 * fake transaction rolls back nothing, so an implementation that claimed in its
 * own connection would pass this file and lose bounces in production. That case
 * lives in `webhooks.integration.test.ts`, against a real database.
 *
 * What belongs here is the SQL that makes the integration result possible, and
 * the branch a container cannot produce cheaply: the second delivery of an
 * event, which must not run the work again.
 */

/** The literal SQL of a statement, with its bound values elided. */
const text = (statement: unknown): string =>
  ((statement as { queryChunks?: unknown[] }).queryChunks ?? [])
    .flatMap((chunk) =>
      typeof chunk === 'object' &&
      chunk !== null &&
      Array.isArray((chunk as { value?: unknown[] }).value)
        ? ((chunk as { value: unknown[] }).value as string[])
        : [],
    )
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

  return { statements, execute, tx: { execute } as unknown as DbTransaction };
};

/**
 * A database whose `transaction` just runs the callback.
 *
 * Honest about what it is: this proves the *call* happens inside whatever the
 * driver gives it, not that a rollback undoes anything. The rollback is the
 * integration file's job, and conflating the two is how a suite reports a
 * guarantee it never tested.
 */
const fakeDatabase = (tx: DbTransaction): Database =>
  ({ transaction: (fn: (t: DbTransaction) => unknown) => Promise.resolve(fn(tx)) }) as Database;

const EVENT = { provider: 'resend', eventId: 'msg_1' } as const;

describe('claimWebhookEvent', () => {
  it('inserts with ON CONFLICT DO NOTHING and returns a row to the winner', async () => {
    const { tx, statements } = capturing([{ event_id: 'msg_1' }]);

    expect(await claimWebhookEvent(tx, EVENT)).toBe(true);

    /*
     * The shape is the point, not the string. `ON CONFLICT DO NOTHING ...
     * RETURNING` is one round trip with no read-then-write race; a `SELECT`
     * followed by an `INSERT` would pass every behavioural assertion in this
     * file and let two concurrent deliveries both through on a slow day.
     */
    const sql = text(statements[0]).replace(/\s+/g, ' ').toLowerCase();
    expect(sql).toContain('insert into processed_webhooks');
    expect(sql).toContain('on conflict (provider, event_id) do nothing');
    expect(sql).toContain('returning event_id');
  });

  it('returns false when the insert conflicted, which is the redelivery case', async () => {
    const { tx } = capturing([]);

    expect(await claimWebhookEvent(tx, EVENT)).toBe(false);
  });

  it('never updates or deletes, because the table forbids both', async () => {
    /*
     * `processed_webhooks` is append-only at the grant level (P0-33a) — `app_rw`
     * holds INSERT and SELECT and neither UPDATE nor DELETE. A `DO UPDATE` here
     * would typecheck, read as an improvement, and fail only in a deployed
     * stage where the grants are real.
     */
    const { tx, statements } = capturing([{ event_id: 'msg_1' }]);
    await claimWebhookEvent(tx, EVENT);

    const sql = text(statements[0]).toLowerCase();
    expect(sql).not.toContain('do update');
    expect(sql).not.toContain('delete');
  });
});

describe('withWebhookEvent', () => {
  it('runs the work and reports the result when the claim is won', async () => {
    const { tx } = capturing([{ event_id: 'msg_1' }]);
    const apply = vi.fn(() => Promise.resolve('suppressed'));

    const run = await withWebhookEvent(EVENT, apply, fakeDatabase(tx));

    expect(run).toEqual({ claimed: true, result: 'suppressed' });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('does not run the work at all when the event was already claimed', async () => {
    /*
     * The branch that makes redelivery safe, and the one worth having twice:
     * this asserts that `apply` is never *entered*, where the integration test
     * asserts that its effects are absent. An implementation that ran the work
     * and relied on each write being idempotent would pass there and not here.
     */
    const { tx } = capturing([]);
    const apply = vi.fn(() => Promise.resolve('suppressed'));

    expect(await withWebhookEvent(EVENT, apply, fakeDatabase(tx))).toEqual({ claimed: false });
    expect(apply).not.toHaveBeenCalled();
  });

  it('hands the work the same transaction the claim was made in', async () => {
    /*
     * The whole design in one assertion. If `apply` were handed anything else,
     * the claim could commit while the work rolled back — and the redelivery
     * that would have repaired it is then refused, permanently and silently.
     */
    const { tx } = capturing([{ event_id: 'msg_1' }]);
    let received: DbTransaction | undefined;

    await withWebhookEvent(
      EVENT,
      (t) => {
        received = t;
        return Promise.resolve();
      },
      fakeDatabase(tx),
    );

    expect(received).toBe(tx);
  });

  it('lets a failure out rather than reporting a claim that did not happen', async () => {
    const { tx } = capturing([{ event_id: 'msg_1' }]);

    await expect(
      withWebhookEvent(
        EVENT,
        () => Promise.reject(new Error('database went away')),
        fakeDatabase(tx),
      ),
    ).rejects.toThrow('database went away');
  });
});
