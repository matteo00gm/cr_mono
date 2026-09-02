import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { auditLog } from '../../src/schema/audit-log.js';

/**
 * Shape assertions for `audit_log` (P0-31).
 */

const config = getTableConfig(auditLog);
const columns = new Map(config.columns.map((c) => [c.name, c]));

describe('audit_log schema', () => {
  it('takes a Better Auth user id, which is not a UUID', () => {
    expect(columns.get('actor_user_id')?.getSQLType()).toBe('text');
  });

  it('allows an action with no human behind it', () => {
    // A Stripe webhook downgrading a subscription changes what a tenant can do
    // and belongs in this log. Attributing it to a person would be a lie.
    expect(columns.get('actor_user_id')?.notNull).toBe(false);
  });

  it('stores ip as inet so a malformed address is refused at write time', () => {
    expect(columns.get('ip')?.getSQLType()).toBe('inet');
  });

  it('keeps action free text, so recording a new one is not a migration', () => {
    expect(columns.get('action')?.getSQLType()).toBe('text');
    expect(columns.get('action')?.notNull).toBe(true);
  });

  it('indexes the one question asked of it before P4 builds a screen', () => {
    const index = config.indexes.find((i) => i.config.name === 'audit_log_tenant_created_idx');

    expect(index).toBeDefined();
  });
});
