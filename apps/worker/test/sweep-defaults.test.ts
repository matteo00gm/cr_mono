import { describe, expect, it, vi } from 'vitest';

import { sweep } from '../src/sweep.js';

/**
 * A sweep with nothing injected drains the real statements (P2-14).
 *
 * Its own file, because it replaces `@catalogorosso/db` for the whole module:
 * the statements need a database, and what is asserted here is only that a run
 * with no options reaches them — a default that quietly did nothing would pass
 * every other test and delete nothing in production.
 */

const prunes = vi.hoisted(() => ({
  revocations: vi.fn<(limit: number) => Promise<number>>(() => Promise.resolve(0)),
  buckets: vi.fn<(limit: number) => Promise<number>>(() => Promise.resolve(0)),
}));

vi.mock('@catalogorosso/db', () => ({
  PRUNE_BATCH: 1_000,
  pruneLapsedRevocations: prunes.revocations,
  pruneClosedWindows: prunes.buckets,
}));

describe('a sweep with nothing injected', () => {
  it('drains both real statements, each with the batch it was given', async () => {
    await sweep({ limit: 7 });

    expect(prunes.revocations).toHaveBeenCalledWith(7);
    expect(prunes.buckets).toHaveBeenCalledWith(7);
  });
});
