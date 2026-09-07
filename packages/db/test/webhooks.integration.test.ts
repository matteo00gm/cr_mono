import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { isSuppressed, suppressAddress } from '../src/email-suppressions.js';
import { claimWebhookEvent, withWebhookEvent } from '../src/webhooks.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The webhook ledger against real Postgres (P0-64b).
 *
 * **The atomicity assertions cannot be written anywhere else**, and they are
 * the reason this file exists rather than a unit test with a fake. What is
 * under test is a transaction boundary: that a claim and the work it guards
 * commit or roll back *together*. A fake that resolves both calls proves the
 * two functions were called, which is precisely the thing that was never in
 * doubt.
 *
 * It connects as `app_rw`, the role the API actually runs as, so the
 * append-only grants on `processed_webhooks` (P0-33a) are in force. A test
 * connecting as the owner would pass while `ON CONFLICT DO NOTHING` was quietly
 * the only shape available for a reason it never encountered.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 4 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

const suppressed = (address: string) => isSuppressed(db, address);

const suppressedAt = async (address: string): Promise<string | undefined> => {
  const rows = await db.execute(
    sql`select suppressed_at::text as at from email_suppressions where address = ${address}`,
  );
  return ([...rows][0] as { at: string } | undefined)?.at;
};

describe('claimWebhookEvent', () => {
  it('claims an event once and refuses it thereafter', async () => {
    const event = { provider: 'resend', eventId: 'msg_claim_once' };

    expect(await claimWebhookEvent(db, event)).toBe(true);
    expect(await claimWebhookEvent(db, event)).toBe(false);
  });

  it('treats the same id from a different provider as a different event', async () => {
    /*
     * `provider` leads the composite key because event ids are only unique
     * within a provider. Without it, Stripe's first `evt_1` would silently
     * swallow Resend's.
     */
    expect(await claimWebhookEvent(db, { provider: 'resend', eventId: 'evt_shared' })).toBe(true);
    expect(await claimWebhookEvent(db, { provider: 'stripe', eventId: 'evt_shared' })).toBe(true);
  });

  it('lets exactly one of many concurrent deliveries through', async () => {
    /*
     * The case a fake cannot reach. Twenty simultaneous claims of one event: a
     * `SELECT` followed by an `INSERT` lets several past, because every caller
     * reads an empty table before any of them writes. Only real connections
     * racing a real database tell that apart from a correct
     * `ON CONFLICT DO NOTHING ... RETURNING`.
     */
    const event = { provider: 'resend', eventId: 'msg_race' };

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => claimWebhookEvent(db, event)),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });
});

describe('withWebhookEvent', () => {
  it('runs the work and reports the claim', async () => {
    const run = await withWebhookEvent(
      { provider: 'resend', eventId: 'msg_applied' },
      async (tx) => {
        await suppressAddress(tx, { address: 'bounced@example.invalid', reason: 'hard_bounce' });
        return 'done';
      },
      db,
    );

    expect(run).toEqual({ claimed: true, result: 'done' });
    expect(await suppressed('bounced@example.invalid')).toBe(true);
  });

  it('does not run the work again for a redelivery', async () => {
    const event = { provider: 'resend', eventId: 'msg_redelivered' };
    let runs = 0;

    const apply = async (tx: Parameters<Parameters<typeof withWebhookEvent>[1]>[0]) => {
      runs += 1;
      await suppressAddress(tx, { address: 'twice@example.invalid', reason: 'hard_bounce' });
    };

    await withWebhookEvent(event, apply, db);
    const first = await suppressedAt('twice@example.invalid');

    const second = await withWebhookEvent(event, apply, db);

    expect(second).toEqual({ claimed: false });
    expect(runs).toBe(1);

    /*
     * The stamp has not moved, which is what the bounce-rate alarm depends on:
     * a redelivery that refreshed `suppressed_at` would make a month-old
     * problem look like it happened this morning, and a provider redelivering a
     * backlog would look like a reputation incident.
     */
    expect(await suppressedAt('twice@example.invalid')).toBe(first);
  });

  it('leaves nothing claimed when the work throws', async () => {
    /*
     * **The assertion this file exists for.** Claim in its own transaction and
     * there is a window where the event is marked processed and the work has
     * not happened — and the provider's redelivery, the one mechanism that
     * would have repaired it, is refused because the ledger says it is done.
     * Permanent, silent, and indistinguishable from success.
     *
     * So: fail inside the work, then prove the ledger did not keep the claim by
     * running the same event again and watching it apply.
     */
    const event = { provider: 'resend', eventId: 'msg_rolled_back' };

    await expect(
      withWebhookEvent(event, () => Promise.reject(new Error('database went away')), db),
    ).rejects.toThrow('database went away');

    expect(await suppressed('rollback@example.invalid')).toBe(false);

    const retry = await withWebhookEvent(
      event,
      async (tx) => {
        await suppressAddress(tx, { address: 'rollback@example.invalid', reason: 'hard_bounce' });
      },
      db,
    );

    expect(retry.claimed).toBe(true);
    expect(await suppressed('rollback@example.invalid')).toBe(true);
  });

  it('rolls back the suppression too when the claim is kept but a later write fails', async () => {
    /*
     * The other direction of the same boundary. A suppression written before a
     * failure would leave an address unmailable with no ledger row explaining
     * why — and `email_suppressions` is the one table here an operator has to
     * edit by hand to undo.
     */
    const event = { provider: 'resend', eventId: 'msg_partial' };

    await expect(
      withWebhookEvent(
        event,
        async (tx) => {
          await suppressAddress(tx, { address: 'partial@example.invalid', reason: 'hard_bounce' });
          throw new Error('the second write failed');
        },
        db,
      ),
    ).rejects.toThrow('the second write failed');

    expect(await suppressed('partial@example.invalid')).toBe(false);
  });
});

describe('the grants, which are what make the ledger a ledger', () => {
  it('refuses to let app_rw delete a claim', async () => {
    /*
     * Verified rather than assumed, because every assertion above would pass
     * against a table `app_rw` could simply clear — at which point "exactly
     * once, ever" holds only until somebody writes a cleanup job. P0-33a is the
     * rule; this is the check that it is still in force on the path that now
     * depends on it.
     */
    await claimWebhookEvent(db, { provider: 'resend', eventId: 'msg_permanent' });

    await expect(
      db.execute(sql`delete from processed_webhooks where event_id = 'msg_permanent'`),
    ).rejects.toThrow(/permission denied/i);
  });
});
