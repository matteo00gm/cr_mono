import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { membershipRole, memberships } from '../../src/schema/memberships.js';

/**
 * Shape assertions for `memberships` (P0-23).
 *
 * This is the table authorisation reads from, so the assertions here are less
 * about the schema being tidy than about the properties P0-47 and P0-49 will
 * assume: one row per user per tenant, a user id that can hold a Better Auth id,
 * and an index that serves the lookup made before any tenant is known.
 */

const config = getTableConfig(memberships);
const columns = new Map(config.columns.map((column) => [column.name, column]));

describe('memberships schema', () => {
  it('declares only the two launch roles', () => {
    // ADMIN and VIEWER arrive later by ALTER TYPE ... ADD VALUE. Shipping them
    // early would mean a capability table (P0-49) with entries nothing checks.
    expect(membershipRole.enumValues).toEqual(['OWNER', 'EDITOR']);
  });

  it('types user_id as text, so a Better Auth id fits', () => {
    // Better Auth generates its own ids and they are not UUIDs. A uuid column
    // would reject every real user id, and this is the table that decides which
    // tenant a request may act on.
    expect(columns.get('user_id')?.getSQLType()).toBe('text');
    expect(columns.get('user_id')?.notNull).toBe(true);
  });

  it('allows one membership per user per tenant', () => {
    // The role is a column on that row. Without this, "promote to OWNER" can
    // land as a second row and every role check becomes ambiguous.
    const constraint = config.uniqueConstraints.find(
      (c) => c.name === 'memberships_tenant_user_unique',
    );

    expect(constraint?.columns.map((c) => c.name)).toEqual(['tenant_id', 'user_id']);
  });

  it('indexes user_id on its own', () => {
    // "Which tenants does this user belong to" runs on every authenticated
    // request, before a tenant is known. The unique constraint's index is on
    // (tenant_id, user_id) and cannot serve a query with no tenant predicate.
    const userIndex = config.indexes.find((i) => i.config.name === 'memberships_user_id_idx');

    expect(userIndex?.config.columns.map((c) => ('name' in c ? c.name : undefined))).toEqual([
      'user_id',
    ]);
  });

  it('cascades from tenants.id', () => {
    // Deleting a tenant must not leave memberships pointing at nothing —
    // orphans here are rows that grant access to a tenant that no longer exists.
    // The target is asserted as well as the action: a foreign key that cascades
    // from the wrong column is still a cascade.
    const [foreignKey] = config.foreignKeys;
    const reference = foreignKey?.reference();

    expect(getTableConfig(reference?.foreignTable ?? memberships).name).toBe('tenants');
    expect(reference?.foreignColumns.map((c) => c.name)).toEqual(['id']);
    expect(foreignKey?.onDelete).toBe('cascade');
  });

  it('leaves invited_by nullable, for the first OWNER', () => {
    expect(columns.get('invited_by')?.notNull).toBe(false);
  });
});
