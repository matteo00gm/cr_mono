import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertAuditRow } from '../src/audit.js';
import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createAuthUser, createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The audit *writer* against real Postgres (P0-53).
 *
 * Distinct from `audit-log.integration.test.ts`, which is P0-31's suite for the
 * table itself — its constraints, its cascade, its append-only grants. This one
 * is about the helper that writes to it.
 *
 * The property that only a real database can answer: **an audit row written
 * inside a transaction that rolls back leaves nothing behind.** That is the
 * whole reason `audit()` takes the caller's `tx` rather than opening its own —
 * an entry for an action that did not happen is worse than no entry, because it
 * is a record people will believe.
 *
 * The `inet` and `jsonb` casts are also only checkable here. A malformed
 * address is refused at write time by the column type, which is why the API
 * captures an address only when it is unambiguous rather than guessing one.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId = '';
let userId = '';

const rowsFor = async (action: string): Promise<Record<string, unknown>[]> => {
  await useTenant(db, tenantId);
  const rows = await db.execute(sql`select * from audit_log where action = ${action}`);
  return [...rows];
};

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  userId = await createAuthUser(db, 'auditor');
  tenantId = await createTenant(db, 'audited-winery');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

describe('a committed action', () => {
  it('leaves its audit row behind', async () => {
    await withTenant(
      tenantId,
      (tx) =>
        insertAuditRow(tx, {
          tenantId,
          actorUserId: userId,
          action: 'domain.added',
          target: 'shop.example',
          metadata: JSON.stringify({ requestId: 'r1' }),
          ip: '203.0.113.7',
          userAgent: 'Firefox/1',
        }),
      db,
    );

    const [row] = await rowsFor('domain.added');

    expect(row?.target).toBe('shop.example');
    expect(row?.actor_user_id).toBe(userId);
    expect(row?.ip).toBe('203.0.113.7');
    expect(row?.user_agent).toBe('Firefox/1');
    expect(row?.metadata).toEqual({ requestId: 'r1' });
  });
});

describe('a rolled-back action', () => {
  it('leaves no audit row at all', async () => {
    /*
     * The assertion the row exists for. The audit write and the action share
     * one transaction, so a failure after the audit — a constraint violation, a
     * last-OWNER guard (P0-52), a lost race — takes the record with it.
     *
     * The rollback is caused by a real failure rather than an explicit
     * `ROLLBACK`, because that is the shape the production path actually has.
     */
    const failed = await withTenant(
      tenantId,
      async (tx) => {
        await insertAuditRow(tx, {
          tenantId,
          actorUserId: userId,
          action: 'member.removed',
          target: undefined,
          metadata: undefined,
          ip: undefined,
          userAgent: undefined,
        });

        // Whatever the action was, it fails after the audit row was written.
        throw new Error('the action failed');
      },
      db,
    ).catch((caught: unknown) => caught);

    expect((failed as Error).message).toBe('the action failed');
    expect(await rowsFor('member.removed')).toHaveLength(0);
  });
});

describe('the column types', () => {
  it('refuses a malformed ip at write time', async () => {
    /*
     * Why `audit_log.ip` is `inet` and not `text`, and why the API captures an
     * address only when the header is unambiguous. A guessed value would be
     * refused here — loudly, in the middle of an unrelated action.
     */
    const error = await withTenant(
      tenantId,
      (tx) =>
        insertAuditRow(tx, {
          tenantId,
          actorUserId: userId,
          action: 'bad.ip',
          target: undefined,
          metadata: undefined,
          ip: 'not-an-address',
          userAgent: undefined,
        }),
      db,
    ).catch((caught: unknown) => caught);

    // invalid_text_representation
    expect(pgErrorCode(error)).toBe('22P02');
  });

  it('accepts an absent actor, ip and user agent', async () => {
    /*
     * Not every audited action has a human behind it. A Stripe webhook
     * downgrading a subscription (P5-09) changes what a tenant can do and
     * belongs in this log; attributing it to a person would be a lie.
     */
    await withTenant(
      tenantId,
      (tx) =>
        insertAuditRow(tx, {
          tenantId,
          actorUserId: undefined,
          action: 'subscription.downgraded',
          target: undefined,
          metadata: undefined,
          ip: undefined,
          userAgent: undefined,
        }),
      db,
    );

    const [row] = await rowsFor('subscription.downgraded');

    expect(row?.actor_user_id).toBeNull();
    expect(row?.ip).toBeNull();
  });
});

describe('the append-only grants', () => {
  it('lets the runtime role insert but not update or delete', async () => {
    /*
     * P0-31's revoke, observed through this writer rather than through a
     * privilege query. An audit log the application can edit records whatever
     * the application last believed, which is not what an audit log is for.
     */
    await useTenant(db, tenantId);

    const update = await db
      .execute(sql`update audit_log set action = 'tampered' where action = 'domain.added'`)
      .catch((caught: unknown) => caught);
    const remove = await db
      .execute(sql`delete from audit_log where action = 'domain.added'`)
      .catch((caught: unknown) => caught);

    // insufficient_privilege, both times.
    expect(pgErrorCode(update)).toBe('42501');
    expect(pgErrorCode(remove)).toBe('42501');
  });

  it('still has the original row afterwards', async () => {
    expect(await rowsFor('domain.added')).toHaveLength(1);
  });
});
