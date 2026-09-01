import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { widgetKeys } from '../../src/schema/widget-keys.js';

/**
 * Shape assertions for `widget_keys` (P0-25).
 *
 * The one that matters is negative: there is no column for a plaintext secret.
 * A schema test can state that as a property of the whole table rather than as
 * a list of columns someone has to keep checking.
 */

const config = getTableConfig(widgetKeys);
const columnNames = config.columns.map((column) => column.name);

describe('widget_keys schema', () => {
  it('has no column that could hold a plaintext secret', () => {
    // Named columns, not a substring check on "secret": the point is that the
    // only secret-derived columns are a hash, a prefix and four characters.
    const secretColumns = columnNames.filter((name) => name.startsWith('secret_'));

    expect(secretColumns.sort()).toEqual([
      'secret_key_hash',
      'secret_key_last4',
      'secret_key_prefix',
    ]);
  });

  it('allows only one active public key per tenant', () => {
    const activeIndex = config.indexes.find(
      (i) => i.config.name === 'widget_keys_one_active_per_tenant',
    );

    expect(activeIndex?.config.unique).toBe(true);
    // Partial, or rotation is impossible: the previous key has to stay in the
    // table for its grace window.
    expect(activeIndex?.config.where).toBeDefined();
  });

  it('keeps grace_until and revoked_at as separate questions', () => {
    // "Stopped being the active key" and "stops working" are different times.
    // Collapsing them forces a choice between breaking every page instantly and
    // never expiring anything.
    const columns = new Map(config.columns.map((column) => [column.name, column]));

    expect(columns.get('revoked_at')?.notNull).toBe(false);
    expect(columns.get('grace_until')?.notNull).toBe(false);
    expect(config.checks.map((c) => c.name)).toContain('widget_keys_grace_requires_revocation');
  });

  it('cascades from tenants.id', () => {
    const [foreignKey] = config.foreignKeys;
    const reference = foreignKey?.reference();

    expect(getTableConfig(reference?.foreignTable ?? widgetKeys).name).toBe('tenants');
    expect(foreignKey?.onDelete).toBe('cascade');
  });
});
