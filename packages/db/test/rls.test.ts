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

  it('gives every policy that can write a WITH CHECK as well as a USING', () => {
    /*
     * USING filters reads. Without WITH CHECK a bug could still insert a row
     * carrying another tenant's id, which reads back as isolation working.
     *
     * *(Amended by P1-31.)* This used to require a WITH CHECK on every policy,
     * counted against the length of the list. A `FOR SELECT` policy cannot have
     * one — Postgres rejects the statement, because there is no new row to
     * check — so the old form did not merely fail for the poller's read policy,
     * it pushed towards writing that policy as `FOR ALL` to satisfy the test.
     * That is the wrong direction: it would have turned a read-only unlock into
     * one admitting INSERT and DELETE, to keep an assertion literally true. So
     * the rule is stated as what it always meant — anything that can write a
     * row says which rows it may write.
     */
    const sql = allMigrationSql();
    const writable = RLS_POLICIES.filter((policy) => policy.for !== 'SELECT');

    expect(sql.match(/USING \(/g)).toHaveLength(RLS_POLICIES.length);
    expect(sql.match(/WITH CHECK \(/g)).toHaveLength(writable.length);
    expect(writable.length).toBeLessThan(RLS_POLICIES.length);
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

  it('unlocks the outbox for reading and releasing, and for nothing else', () => {
    /*
     * The poller's flag is the one context here that *widens*: a transaction
     * that sets it sees every tenant's outbox rows, which is what draining one
     * queue for the whole platform requires (P1-31, and the argument is in
     * with-outbox.ts).
     *
     * What keeps that bounded is the command split, so it is asserted rather
     * than left to the reader of the SQL. A `FOR ALL` unlock would also admit
     * INSERT — a path that could forge a job pointing at another tenant — and
     * DELETE, a path that could drop one. Neither is anything the poller does,
     * and a policy that grants what its caller never uses is a policy nobody
     * will notice being used.
     */
    const poller = RLS_POLICIES.filter((policy) => policy.using.includes('app.outbox_poller'));

    expect(poller.map((policy) => policy.for)).toEqual(['SELECT', 'UPDATE']);
    expect(poller.every((policy) => policy.table === 'outbox')).toBe(true);
  });

  it('leaves the outbox scoped by tenant for everybody else', () => {
    /*
     * The poller policy is *additional*. Postgres ORs permissive policies
     * together, so the danger of amending a protected table is not that the new
     * policy is too narrow — it is that the old one stops being there. A
     * request that sets no flag must still see one tenant's rows, and the
     * writer that enqueues a job must still be unable to name another tenant.
     */
    const tenantIsolation = RLS_POLICIES.find(
      (policy) => policy.table === 'outbox' && policy.name === undefined,
    );

    expect(tenantIsolation?.using).toContain("current_setting('app.tenant_id'");
    /*
     * The comments are stripped before matching, and both halves of that are
     * deliberate. Matching the bare word would hit the notes, which say "no
     * INSERT" and "no DELETE" in prose; matching `FOR ALL` would hit the note
     * explaining why the policy is *not* written that way. What is left is the
     * SQL, which is the only part Postgres reads.
     */
    const statements = rlsMigrationSql('0036_outbox_poller_rls')
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n');

    expect(statements).not.toMatch(/FOR (INSERT|DELETE|ALL)\b/);
    expect(statements).toMatch(/FOR SELECT/);
    expect(statements).toMatch(/FOR UPDATE/);
  });

  it('reverses an amending migration without unscoping the table it amended', () => {
    /*
     * **The failure this exists for is silent and total.** The generated down
     * file for a normal policy disables RLS on its table; emitted for a policy
     * that was *added* to an already-protected table, it would take
     * tenant_isolation and FORCE down with it. Rolling back P1-31 would then
     * leave `outbox` with no row-level security at all, and every query against
     * it would start returning every tenant's rows — with nothing failing.
     */
    const down = rlsDownSql('0036_outbox_poller_rls');

    expect(down).toContain('DROP POLICY IF EXISTS outbox_poller_read ON outbox;');
    expect(down).not.toContain('DISABLE ROW LEVEL SECURITY');
    expect(down).not.toContain('NO FORCE ROW LEVEL SECURITY');
  });

  it('does not claim to enable RLS in a migration that only adds a policy', () => {
    // Harmless as SQL — the statement is idempotent — and misleading as a
    // record: a reader would take this file for the place isolation begins.
    expect(rlsMigrationSql('0036_outbox_poller_rls')).not.toContain('ENABLE ROW LEVEL SECURITY');
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
