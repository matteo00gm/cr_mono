import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  domainStatus,
  domainVerificationMethod,
  tenantDomains,
} from '../../src/schema/tenant-domains.js';

/**
 * Shape assertions for `tenant_domains` (P0-24).
 *
 * The behaviour is proved against a real server in the integration suite; what
 * is pinned here is that the two constraints carrying the anti-sharing design
 * are declared at all. Both are the kind of thing a later refactor drops without
 * any test noticing — a unique constraint quietly scoped to a tenant, a CHECK
 * removed because it "was already validated in the API".
 */

const config = getTableConfig(tenantDomains);
const columns = new Map(config.columns.map((column) => [column.name, column]));

describe('tenant_domains schema', () => {
  it('makes origin unique across every tenant', () => {
    // Per-tenant uniqueness would permit exactly the thing §3.2 exists to stop:
    // two tenants both claiming https://winery.com.
    expect(columns.get('origin')?.isUnique).toBe(true);
  });

  it('constrains the stored origin format', () => {
    expect(config.checks.map((c) => c.name)).toContain('tenant_domains_origin_format');
  });

  it('starts a domain PENDING', () => {
    // A domain serviceable the moment it is typed in is a widget anyone can
    // install anywhere by claiming the origin.
    expect(columns.get('status')?.default).toBe('PENDING');
    expect(domainStatus.enumValues).toEqual(['PENDING', 'VERIFIED']);
  });

  it('offers both proofs of control from §3.3', () => {
    expect(domainVerificationMethod.enumValues).toEqual(['DNS_TXT', 'WELL_KNOWN']);
  });

  it('leaves verified_at null until verification actually happens', () => {
    // Nullable rather than defaulted: "when was this verified" has to be able to
    // answer "it was not".
    expect(columns.get('verified_at')?.notNull).toBe(false);
    expect(columns.get('verified_at')?.hasDefault).toBe(false);
  });

  it('indexes tenant_id, which the unique index on origin does not cover', () => {
    const tenantIndex = config.indexes.find(
      (i) => i.config.name === 'tenant_domains_tenant_id_idx',
    );

    expect(tenantIndex).toBeDefined();
  });

  it('cascades from tenants.id', () => {
    // An origin left behind by a deleted tenant still holds the unique
    // constraint, so the domain could never be claimed again.
    const [foreignKey] = config.foreignKeys;
    const reference = foreignKey?.reference();

    expect(getTableConfig(reference?.foreignTable ?? tenantDomains).name).toBe('tenants');
    expect(reference?.foreignColumns.map((c) => c.name)).toEqual(['id']);
    expect(foreignKey?.onDelete).toBe('cascade');
  });
});
