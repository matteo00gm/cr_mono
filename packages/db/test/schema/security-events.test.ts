import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { securityEvents, securityEventType } from '../../src/schema/security-events.js';

/**
 * Shape assertions for `security_events` (P0-32).
 */

const config = getTableConfig(securityEvents);
const columns = new Map(config.columns.map((c) => [c.name, c]));

describe('security_events schema', () => {
  it('declares the six rejection types from §Data Model', () => {
    expect(securityEventType.enumValues).toEqual([
      'UNAUTHORIZED_ORIGIN',
      'INVALID_KEY',
      'TOKEN_ORIGIN_MISMATCH',
      'RATE_LIMITED',
      'QUOTA_EXCEEDED',
      'REPLAYED_WEBHOOK',
    ]);
  });

  it('records an event that belongs to no tenant', () => {
    // An INVALID_KEY has no resolvable tenant — that is why it was rejected.
    // A not-null column here would silence the log exactly when it matters.
    expect(columns.get('tenant_id')?.notNull).toBe(false);
  });

  it('counts by key and origin without leading on tenant', () => {
    // P2-16 asks how often this key came from this origin, and the rows that
    // matter most are the ones with no tenant at all.
    const index = config.indexes.find((i) => i.config.name === 'security_events_key_origin_idx');

    expect(index?.config.columns.map((c) => ('name' in c ? c.name : ''))).toEqual([
      'public_key',
      'origin',
    ]);
  });
});
