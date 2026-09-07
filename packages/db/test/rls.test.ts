import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { RLS_POLICIES, rlsDownSql, rlsMigrationSql, rlsMigrations } from '../src/rls.js';

/**
 * The policy list and the migration it generates (P0-37).
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Every generated migration, concatenated.
 *
 * The structural assertions below are about the policy *set*, which now spans
 * more than one file: a table added after P0-37 gets its own migration, because
 * `0025_rls.sql` is applied history and appending to it would mean a database
 * that already ran it never receives the new policy.
 */
const allMigrationSql = (): string =>
  rlsMigrations()
    .map((migration) => rlsMigrationSql(migration))
    .join('\n');

describe('rls migration', () => {
  it('matches the committed migration exactly', () => {
    /*
     * The check that makes generation worth anything. Adding a table to
     * RLS_POLICIES and forgetting to regenerate leaves a table with no policy
     * in the database while the list claims otherwise — and the list is what
     * the next person will read.
     */
    for (const migration of rlsMigrations()) {
      const committed = readFileSync(join(MIGRATIONS, `${migration}.sql`), 'utf8');

      expect(rlsMigrationSql(migration), migration).toBe(committed);
    }
  });

  it('matches the committed reverse exactly', () => {
    for (const migration of rlsMigrations()) {
      const committed = readFileSync(join(MIGRATIONS, `down/${migration}.sql`), 'utf8');

      expect(rlsDownSql(migration), migration).toBe(committed);
    }
  });

  it('forces RLS on every table, not merely enables it', () => {
    // Without FORCE the table owner bypasses the policy, and app_migrate owns
    // every one of these. That single missing word would make the whole
    // migration decorative.
    const sql = allMigrationSql();

    for (const { table } of RLS_POLICIES) {
      expect(sql, table).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }
  });

  it('gives every policy a WITH CHECK as well as a USING', () => {
    // USING filters reads. Without WITH CHECK a bug could still insert a row
    // carrying another tenant's id, which reads back as isolation working.
    const sql = allMigrationSql();

    expect(sql.match(/USING \(/g)).toHaveLength(RLS_POLICIES.length);
    expect(sql.match(/WITH CHECK \(/g)).toHaveLength(RLS_POLICIES.length);
  });

  it('wraps every GUC read in nullif', () => {
    // An ended transaction leaves the setting as '' rather than unset, and
    // ''::uuid raises 22P02. Without nullif a query outside withTenant fails
    // with a type error instead of returning nothing.
    const sql = allMigrationSql();
    const reads = sql.match(/current_setting\([^)]*\)/g) ?? [];

    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(sql).toContain(`nullif(${read}, '')`);
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

  it('omits the tables that have no tenant to scope by', () => {
    const tables = RLS_POLICIES.map((p) => p.table);

    expect(tables).not.toContain('processed_webhooks');
    expect(tables).not.toContain('rate_limit_buckets');
    // P0-64: a bounce protects the sending domain, which belongs to no tenant.
    expect(tables).not.toContain('email_suppressions');
  });

  it('puts a policy added after P0-37 in its own migration', () => {
    /*
     * The property that keeps generation honest as the schema grows. Appending
     * `invitations` to `0025_rls.sql` would leave every database that already
     * ran it without the policy, while the file — and this suite — claimed
     * otherwise. The failure would be invisible until a cross-tenant read.
     */
    const invitations = RLS_POLICIES.find((p) => p.table === 'invitations');

    expect(invitations?.migration).toBe('0033_invitations_rls');
    expect(rlsMigrationSql()).not.toContain('ON invitations');
  });
});
