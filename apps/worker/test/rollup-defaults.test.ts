import { describe, expect, it, vi } from 'vitest';

import { rollup } from '../src/rollup.js';

/**
 * A rollup with nothing injected reads the real directory and writes through
 * the tenant's own scope (P5-13). Its own file, because it replaces
 * `@catalogorosso/db` for the whole module.
 */

const db = vi.hoisted(() => ({
  listTenantDirectory: vi.fn(() =>
    Promise.resolve([{ id: 't1', createdAt: new Date('2026-01-01T00:00:00Z') }]),
  ),
  withTenant: vi.fn((tenantId: string, fn: (tx: string) => Promise<unknown>) =>
    fn(`tx-for-${tenantId}`),
  ),
  rollupUsageDay: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@catalogorosso/db', () => db);

describe('a rollup with nothing injected', () => {
  it('lists the directory, and rolls each day up inside that tenant’s own scope', async () => {
    await rollup({ now: () => new Date('2026-10-15T01:30:00Z'), days: 1 });

    expect(db.listTenantDirectory).toHaveBeenCalled();
    expect(db.withTenant).toHaveBeenCalledWith('t1', expect.any(Function));
    expect(db.rollupUsageDay).toHaveBeenCalledWith('tx-for-t1', '2026-10-14');
  });
});
