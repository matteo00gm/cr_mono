import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { processedWebhooks } from '../../src/schema/processed-webhooks.js';

/**
 * Shape assertions for `processed_webhooks` (P0-33).
 */

const config = getTableConfig(processedWebhooks);

describe('processed_webhooks schema', () => {
  it('is keyed by (provider, event_id), provider first', () => {
    // The key is the idempotency mechanism. provider leads because event ids
    // are only unique within a provider.
    expect(config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(['provider', 'event_id']);
  });

  it('carries no tenant column', () => {
    // The tenant is derived from the event, so it is not known when the row is
    // written — and for an event naming an unknown customer, never is. P0-41's
    // reflection test needs this table allowlisted for exactly that reason.
    expect(config.columns.map((c) => c.name)).not.toContain('tenant_id');
  });

  it('has no surrogate id to identify a row by instead', () => {
    expect(config.columns.map((c) => c.name)).toEqual(['provider', 'event_id', 'processed_at']);
  });
});
