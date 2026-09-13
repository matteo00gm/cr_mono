import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { importRuns } from '../../src/schema/import-runs.js';

/**
 * Shape assertions for `import_runs` (P1-26).
 */

const config = getTableConfig(importRuns);
const columns = new Map(config.columns.map((c) => [c.name, c]));

describe('import_runs schema', () => {
  it('makes a key unique within a winery, never across wineries', () => {
    // A global constraint would let one tenant's key refuse another's import,
    // and the refusal would tell the second tenant the key exists.
    const unique = config.uniqueConstraints.find((c) => c.name === 'import_runs_tenant_key_unique');

    expect(unique?.columns.map((column) => column.name)).toEqual(['tenant_id', 'idempotency_key']);
  });

  it('leaves the result null until the attempt completes', () => {
    // Null is what "still running" means; a default would replay an empty answer.
    expect(columns.get('result')?.notNull).toBe(false);
    expect(columns.get('result')?.hasDefault).toBe(false);
  });

  it('timestamps the claim, which is what the expiry reads', () => {
    expect(columns.get('claimed_at')?.notNull).toBe(true);
    expect(columns.get('claimed_at')?.hasDefault).toBe(true);
  });

  it('goes with the winery it belongs to', () => {
    expect(config.foreignKeys[0]?.onDelete).toBe('cascade');
  });
});
