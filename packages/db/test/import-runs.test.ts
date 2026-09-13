import { describe, expect, it, vi } from 'vitest';

import { claimImportRun, completeImportRun } from '../src/import-runs.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * Claiming an import attempt, without a database (P1-26).
 *
 * Which answer each row shape produces. The statement's own guarantees — that
 * two concurrent claims cannot both win, that another winery's key never
 * conflicts, that an expired claim is taken over — are a constraint, a policy
 * and real SQL, and live in `import-runs.integration.test.ts`.
 */

const REQUEST = { tenantId: 't-1', idempotencyKey: 'k-1', requestHash: 'h-1' };

/** A transaction whose `execute` answers each call with the next result. */
const fakeTx = (...results: unknown[][]) => {
  const execute = vi.fn(() => Promise.resolve(results.shift() ?? []));
  return { execute, tx: { execute } as unknown as DbTransaction };
};

describe('claimImportRun', () => {
  it('claims a key nobody holds, reading nothing else', async () => {
    const fake = fakeTx([{ id: 'run-1' }]);

    expect(await claimImportRun(fake.tx, REQUEST)).toEqual({ outcome: 'claimed', runId: 'run-1' });
    expect(fake.execute).toHaveBeenCalledTimes(1);
  });

  it('replays the stored result for the same body', async () => {
    const stored = { counts: { created: 3 } };
    const fake = fakeTx([], [{ request_hash: 'h-1', result: stored }]);

    expect(await claimImportRun(fake.tx, REQUEST)).toEqual({ outcome: 'replay', result: stored });
  });

  it('says a run with no result yet is still in progress', async () => {
    const fake = fakeTx([], [{ request_hash: 'h-1', result: null }]);

    expect(await claimImportRun(fake.tx, REQUEST)).toEqual({ outcome: 'in-progress' });
  });

  it('refuses the same key with a different body, whatever the first one returned', async () => {
    const running = fakeTx([], [{ request_hash: 'other', result: null }]);
    const finished = fakeTx([], [{ request_hash: 'other', result: { counts: {} } }]);

    expect(await claimImportRun(running.tx, REQUEST)).toEqual({ outcome: 'different-body' });
    expect(await claimImportRun(finished.tx, REQUEST)).toEqual({ outcome: 'different-body' });
  });

  it('refuses to guess when the conflicting run cannot be read', async () => {
    const fake = fakeTx([], []);

    await expect(claimImportRun(fake.tx, REQUEST)).rejects.toThrow(/not visible/);
  });
});

describe('completeImportRun', () => {
  it('stores the response, which is what a replay will answer with', async () => {
    const fake = fakeTx([]);

    await completeImportRun(fake.tx, { runId: 'run-1', result: { counts: { created: 1 } } });

    expect(fake.execute).toHaveBeenCalledTimes(1);
  });
});
