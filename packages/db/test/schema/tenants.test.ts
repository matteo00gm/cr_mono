import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { tenantPlan, tenants, tenantStatus } from '../../src/schema/tenants.js';

/**
 * Shape assertions for `tenants` (P0-22).
 *
 * Everything these check has a consequence somewhere else: the status values
 * are what P5's webhook state machine switches on, the default is what keeps an
 * abandoned signup from being serviceable, and the unique constraints are what
 * let a Stripe webhook find exactly one row. A migration that quietly loses one
 * of them fails here rather than in the incident it would otherwise cause.
 *
 * They also run without Docker, which is the difference between an assertion
 * that runs on every commit and one that runs when someone remembers.
 */

const columns = new Map(getTableConfig(tenants).columns.map((column) => [column.name, column]));

describe('tenants schema', () => {
  it('declares the six documented lifecycle states', () => {
    expect(tenantStatus.enumValues).toEqual([
      'PENDING_VERIFICATION',
      'TRIALING',
      'ACTIVE',
      'PAST_DUE',
      'DISABLED',
      'CANCELED',
    ]);
  });

  it('declares the launch plans', () => {
    expect(tenantPlan.enumValues).toEqual(['CANTINA', 'ECOMMERCE']);
  });

  it('defaults status to PENDING_VERIFICATION', () => {
    // A default of ACTIVE would make every abandoned signup a live account.
    expect(columns.get('status')?.default).toBe('PENDING_VERIFICATION');
  });

  it('leaves plan nullable, so "no subscription yet" is representable', () => {
    // Any non-null default here reads downstream as a real entitlement.
    expect(columns.get('plan')?.notNull).toBe(false);
    expect(columns.get('plan')?.hasDefault).toBe(false);
  });

  it('stores slug as citext so case-variant slugs cannot collide', () => {
    // `text` plus lowercase-on-write is one forgotten code path away from
    // `Winery` and `winery` being two tenants.
    expect(columns.get('slug')?.getSQLType()).toBe('citext');
  });

  it.each(['slug', 'stripe_customer_id', 'stripe_subscription_id'])('keeps %s unique', (column) => {
    expect(columns.get(column)?.isUnique).toBe(true);
  });

  it('generates ids in the database, not the application', () => {
    // A default here means an insert that forgets an id still gets a valid one,
    // and that ids are unguessable without trusting every call site.
    expect(columns.get('id')?.hasDefault).toBe(true);
    expect(columns.get('id')?.primary).toBe(true);
  });

  it('timestamps with a time zone', () => {
    // `timestamp without time zone` silently reinterprets on every read from a
    // process in a different zone — and Lambda runs in UTC while the seller is
    // in Europe/Rome.
    for (const column of ['created_at', 'updated_at']) {
      expect(columns.get(column)?.getSQLType()).toBe('timestamp with time zone');
    }
  });
});
