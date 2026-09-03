import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { rateLimitBuckets } from '../../src/schema/rate-limit-buckets.js';

/**
 * Shape assertions for `rate_limit_buckets` (P0-34).
 */

const config = getTableConfig(rateLimitBuckets);

describe('rate_limit_buckets schema', () => {
  it('is keyed by (bucket_key, window_start)', () => {
    // What makes the limiter check one INSERT ... ON CONFLICT DO UPDATE, with
    // no read-then-write race between checking a count and incrementing it.
    expect(config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      'bucket_key',
      'window_start',
    ]);
  });

  it('indexes window_start for the prune job', () => {
    // P2-14 scans by time, not by key, so the primary key does not serve it.
    const index = config.indexes.find(
      (i) => i.config.name === 'rate_limit_buckets_window_start_idx',
    );

    expect(index).toBeDefined();
  });

  it('carries no tenant_id, because bucket_key encodes the subject', () => {
    // The limiter also counts things belonging to no tenant — an IP hammering
    // an invalid key — so a tenant column could not hold every row.
    expect(config.columns.map((c) => c.name)).not.toContain('tenant_id');
  });
});
