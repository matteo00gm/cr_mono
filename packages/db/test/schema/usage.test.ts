import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { usageDaily, usageEvents } from '../../src/schema/usage.js';

/**
 * Shape assertions for `usage_events` and `usage_daily` (P0-30).
 */

const events = getTableConfig(usageEvents);
const daily = getTableConfig(usageDaily);
const eventColumns = new Map(events.columns.map((c) => [c.name, c]));
const dailyColumns = new Map(daily.columns.map((c) => [c.name, c]));

describe('usage_events schema', () => {
  it('constrains period to YYYYMM', () => {
    // The quota check is an equality lookup on this column. A row written as
    // `2026-09` would be invisible to it — which fails open, granting
    // unlimited usage rather than denying it.
    const check = events.checks.find((c) => c.name === 'usage_events_period_format');

    expect(check).toBeDefined();
  });

  it('meters cost in integer micros, not a float', () => {
    // Costs are summed across many rows and compared against an allowance.
    // Binary floating point makes that sum depend on the order it was taken in.
    expect(eventColumns.get('cost_micros')?.getSQLType()).toBe('bigint');
  });

  it('allows an event with no session', () => {
    // A bulk reindex costs embedding tokens and is started from the dashboard,
    // where there is no visitor session to attribute it to.
    expect(eventColumns.get('session_id')?.notNull).toBe(false);
  });

  it('keeps kind as text, leaving the value set to the P0-42 contract', () => {
    expect(eventColumns.get('kind')?.getSQLType()).toBe('text');
  });

  it('indexes the quota lookup on (tenant_id, period)', () => {
    const index = events.indexes.find((i) => i.config.name === 'usage_events_tenant_period_idx');

    expect(index?.config.columns.map((c) => ('name' in c ? c.name : ''))).toEqual([
      'tenant_id',
      'period',
    ]);
  });
});

describe('usage_daily schema', () => {
  it('is keyed by (tenant_id, day) so a re-run upserts rather than duplicates', () => {
    expect(daily.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(['tenant_id', 'day']);
  });

  it('defaults every counter to zero rather than allowing null', () => {
    // A missing day and a day with no activity are different facts. Null would
    // conflate them and put a coalesce in every dashboard sum.
    for (const name of ['messages', 'conversations', 'add_to_carts', 'tokens_in', 'tokens_out']) {
      expect(dailyColumns.get(name)?.notNull, name).toBe(true);
      expect(dailyColumns.get(name)?.hasDefault, name).toBe(true);
    }
  });
});
