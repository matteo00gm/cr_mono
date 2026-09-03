import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { RLS_POLICIES, rlsDownSql, rlsMigrationSql } from '../src/rls.js';

/**
 * The policy list and the migration it generates (P0-37).
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

describe('rls migration', () => {
  it('matches the committed migration exactly', () => {
    /*
     * The check that makes generation worth anything. Adding a table to
     * RLS_POLICIES and forgetting to regenerate leaves a table with no policy
     * in the database while the list claims otherwise — and the list is what
     * the next person will read.
     */
    const committed = readFileSync(join(MIGRATIONS, '0025_rls.sql'), 'utf8');

    expect(rlsMigrationSql()).toBe(committed);
  });

  it('matches the committed reverse exactly', () => {
    const committed = readFileSync(join(MIGRATIONS, 'down/0025_rls.sql'), 'utf8');

    expect(rlsDownSql()).toBe(committed);
  });

  it('forces RLS on every table, not merely enables it', () => {
    // Without FORCE the table owner bypasses the policy, and app_migrate owns
    // every one of these. That single missing word would make the whole
    // migration decorative.
    const sql = rlsMigrationSql();

    for (const { table } of RLS_POLICIES) {
      expect(sql, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }
  });

  it('gives every policy a WITH CHECK as well as a USING', () => {
    // USING filters reads. Without WITH CHECK a bug could still insert a row
    // carrying another tenant's id, which reads back as isolation working.
    const sql = rlsMigrationSql();

    expect(sql.match(/USING \(/g)).toHaveLength(RLS_POLICIES.length);
    expect(sql.match(/WITH CHECK \(/g)).toHaveLength(RLS_POLICIES.length);
  });

  it('wraps every GUC read in nullif', () => {
    // An ended transaction leaves the setting as '' rather than unset, and
    // ''::uuid raises 22P02. Without nullif a query outside withTenant fails
    // with a type error instead of returning nothing.
    const reads = rlsMigrationSql().match(/current_setting\([^)]*\)/g) ?? [];

    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(rlsMigrationSql()).toContain(`nullif(${read}, '')`);
    }
  });

  it('keeps memberships WITH CHECK tenant-only', () => {
    // The USING branch on app.user_id is what makes login work. Repeating it
    // in WITH CHECK would let any authenticated user insert a membership for
    // themselves into any tenant — self-service privilege escalation.
    const memberships = RLS_POLICIES.find((p) => p.table === 'memberships');

    expect(memberships?.using).toContain('app.user_id');
    expect(memberships?.withCheck).not.toContain('app.user_id');
  });

  it('lets security_events write a row that belongs to no tenant', () => {
    // An INVALID_KEY rejection matched no tenant. The boilerplate WITH CHECK
    // rejects it outright, so the application would fail to record an attack
    // at the moment it is under one.
    const securityEvents = RLS_POLICIES.find((p) => p.table === 'security_events');

    expect(securityEvents?.withCheck).toContain('tenant_id IS NULL');
    expect(securityEvents?.using).not.toContain('IS NULL');
  });

  it('omits the two tables that have no tenant to scope by', () => {
    const tables = RLS_POLICIES.map((p) => p.table);

    expect(tables).not.toContain('processed_webhooks');
    expect(tables).not.toContain('rate_limit_buckets');
  });
});
