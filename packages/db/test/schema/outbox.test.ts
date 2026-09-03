import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { outbox } from '../../src/schema/outbox.js';

/**
 * Shape assertions for `outbox` (P0-36).
 */

const config = getTableConfig(outbox);
const columns = new Map(config.columns.map((c) => [c.name, c]));

describe('outbox schema', () => {
  it('indexes only the unprocessed rows', () => {
    // The poller asks one question — what is unprocessed — and that answer is a
    // shrinking set inside a table that only grows. A full index would keep
    // every published row in it and decay steadily.
    const index = config.indexes.find((i) => i.config.name === 'outbox_unprocessed_idx');

    expect(index?.config.where).toBeDefined();
  });

  it('leaves processed_at null until the poller publishes', () => {
    // The queue of work is the nulls; a default would empty the queue.
    expect(columns.get('processed_at')?.notNull).toBe(false);
    expect(columns.get('processed_at')?.hasDefault).toBe(false);
  });

  it('counts attempts from zero rather than from null', () => {
    expect(columns.get('attempts')?.notNull).toBe(true);
    expect(columns.get('attempts')?.hasDefault).toBe(true);
  });

  it('orders by a monotonic id, so the poller needs no separate sort column', () => {
    expect(columns.get('id')?.primary).toBe(true);
  });
});
