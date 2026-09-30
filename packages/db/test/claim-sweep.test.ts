import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import {
  CLAIM_SWEEP_LIMIT,
  CLAIM_SWEEPER_GUC,
  markClaimNotified,
  NestedClaimSweepContextError,
  readClaimWork,
} from '../src/claim-sweep.js';
import type { Database } from '../src/client.js';
import { withTenant, type DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The claim sweep's read and its stamp, without a database (P4-18b).
 *
 * The mechanics: the flag is set in a read-only transaction, the statement
 * narrows to real work, and the stamp is conditional on the state it was sent
 * for. What the flag actually admits is `claim-sweep.integration`'s.
 */

const TENANT = 'a0000000-0000-4000-8000-000000000001';

const createMockDb = (results: unknown[][]) => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve(results.shift() ?? []);
  });
  const tx = { execute } as unknown as DbTransaction;
  /* Typed with the config argument, so a test can read what the transaction was opened with. */
  const transaction = vi.fn<
    (cb: (tx: DbTransaction) => Promise<unknown>, config?: unknown) => Promise<unknown>
  >((cb) => cb(tx));

  return { db: { transaction } as unknown as Database, tx, statements, transaction };
};

const params = (statement: unknown): unknown[] =>
  new PgDialect().sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]).params;

describe('reading the work', () => {
  it('sets the flag in a read-only transaction, and maps each claim', async () => {
    const { db, statements, transaction } = createMockDb([
      [],
      [
        {
          id: 'c1',
          tenant_id: 't1',
          incumbent_tenant_id: 't2',
          origin: 'https://www.winery.com',
          status: 'NOTICE',
          notified_status: null,
          due: false,
        },
      ],
    ]);

    await expect(readClaimWork(undefined, db)).resolves.toEqual([
      {
        id: 'c1',
        claimantTenantId: 't1',
        incumbentTenantId: 't2',
        origin: 'https://www.winery.com',
        status: 'NOTICE',
        notifiedStatus: null,
        due: false,
      },
    ]);
    expect(transaction.mock.calls[0]?.[1]).toEqual({ accessMode: 'read only' });
    expect(params(statements[0])).toEqual([CLAIM_SWEEPER_GUC]);
    expect(text(statements[0])).toContain("'on'");
    expect(params(statements[1])).toEqual([CLAIM_SWEEP_LIMIT]);
  });

  it('narrows to real work: notices unsent or run out, outcomes untold', async () => {
    const { db, statements } = createMockDb([[], []]);

    await readClaimWork(5, db);

    expect(text(statements[1])).toContain(
      "(status = 'NOTICE' AND (notified_at IS NULL OR transfer_at <= now()))",
    );
    expect(text(statements[1])).toContain(
      "(status IN ('TRANSFERRED', 'CANCELED') AND notified_status IS DISTINCT FROM status)",
    );
    expect(text(statements[1])).toContain(
      "(status = 'NOTICE' AND notified_at IS NOT NULL AND transfer_at <= now()) AS due",
    );
    expect(params(statements[1])).toEqual([5]);
  });

  it('refuses to open inside a tenant context, and names the tenant', async () => {
    const { db, transaction } = createMockDb([]);

    const error: unknown = await withTenant(TENANT, () => readClaimWork(5, db), db).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(NestedClaimSweepContextError);
    expect((error as Error).message).toContain(TENANT);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe('stamping what was told', () => {
  it('restarts a notice’s clock from the moment it was sent', async () => {
    const { tx, statements } = createMockDb([
      [{ status: 'NOTICE', transfer_at: new Date('2026-10-02T09:00:00Z') }],
    ]);

    await expect(markClaimNotified(tx, 'c1', 'NOTICE', 72)).resolves.toEqual(
      new Date('2026-10-02T09:00:00Z'),
    );
    expect(text(statements[0])).toContain(
      "WHEN status = 'NOTICE' THEN now() + make_interval(hours =>",
    );
    expect(text(statements[0])).toContain('AND notified_status IS DISTINCT FROM status');
    expect(text(statements[0])).toContain(
      "tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid",
    );
    expect(params(statements[0])).toEqual([72, 'c1', 'NOTICE']);
  });

  it('answers null for an outcome, which has no deadline', async () => {
    const { tx } = createMockDb([[{ status: 'TRANSFERRED', transfer_at: null }]]);

    await expect(markClaimNotified(tx, 'c1', 'TRANSFERRED', 72)).resolves.toBeNull();
  });

  it('answers undefined when nothing was stamped', async () => {
    const { tx } = createMockDb([[]]);

    await expect(markClaimNotified(tx, 'c1', 'NOTICE', 72)).resolves.toBeUndefined();
  });
});
