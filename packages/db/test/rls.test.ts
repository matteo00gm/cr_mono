import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { REVOCATION_SWEEP_GRACE_SEC } from '../src/revocation-grace.js';
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

  it('keeps the outbox WITH CHECK tenant-only, so the poller flag buys a read', () => {
    /*
     * **The line that keeps a cross-tenant read from being a cross-tenant
     * write.** The flag has to appear in USING — draining one queue for the
     * whole platform has no tenant to be scoped to — and it must not appear in
     * WITH CHECK, or a transaction holding it could insert a job naming any
     * tenant and delete anybody's. The poller's own releases work because
     * `runOutboxPass` sets app.tenant_id from the row it claimed before it
     * updates, which is the same shape `withInvitation` uses.
     *
     * Same rule as memberships, one line below, and for a reason of the same
     * kind: a GUC that widens reads must never widen writes.
     */
    const outbox = RLS_POLICIES.filter((policy) => policy.table === 'outbox');
    const current = outbox.at(-1);

    expect(current?.using).toContain('app.outbox_poller');
    expect(current?.withCheck).not.toContain('app.outbox_poller');
    expect(current?.withCheck).toContain("current_setting('app.tenant_id'");
  });

  it('replaces the outbox policy rather than adding a second one', () => {
    /*
     * **A second permissive policy does not modify the first, it bypasses it**
     * — Postgres ORs them — and every existing isolation test still passes,
     * because they only assert what one tenant can see.
     * `rls-coverage.integration.test.ts` asserts this against a live database;
     * this is the same rule at the level of the list, where it is cheaper to
     * notice. So a policy that has to change is dropped and re-created under
     * its own name.
     */
    const sql = rlsMigrationSql('0036_outbox_poller_rls');

    expect(sql).toContain('DROP POLICY IF EXISTS tenant_isolation ON outbox;');
    expect(sql.match(/CREATE POLICY (\w+)/g)).toEqual(['CREATE POLICY tenant_isolation']);
  });

  it('reverses a superseding migration to the policy it replaced', () => {
    /*
     * **Two silent failures live here, and the second is the dangerous one.**
     * A down file that drops the new policy and stops leaves the table with no
     * policy while RLS stays forced — every query returns nothing. One that
     * disables RLS instead leaves the table with no isolation at all, and
     * nothing fails. The correct reverse re-creates what was there before.
     */
    const down = rlsDownSql('0036_outbox_poller_rls');

    expect(down).toContain('CREATE POLICY tenant_isolation ON outbox');
    expect(down).not.toContain('app.outbox_poller');
    expect(down).not.toContain('DISABLE ROW LEVEL SECURITY');
    expect(down).not.toContain('NO FORCE ROW LEVEL SECURITY');
  });

  it('lets the sweep flag reach only revocations past the continuation window (P2-14)', () => {
    /*
     * **The flag and the predicate are one branch.** A flag on its own in USING
     * would admit every tenant's live revocations, and a DELETE is filtered by
     * USING alone — so the sweep could clear a revocation that is still
     * refusing a continuing session. WITH CHECK stays tenant-only, as the
     * poller's does, so the flag cannot write.
     */
    const current = RLS_POLICIES.filter((policy) => policy.table === 'token_revocations').at(-1);

    expect(current?.using).toContain(
      "OR (nullif(current_setting('app.revocation_sweeper', true), '') = 'on'\n" +
        `      AND expires_at < now() - make_interval(secs => ${String(REVOCATION_SWEEP_GRACE_SEC)}))`,
    );
    expect(current?.withCheck).not.toContain('app.revocation_sweeper');
    expect(rlsDownSql('0043_revocation_sweep_rls')).not.toContain('app.revocation_sweeper');
  });

  it('does not claim to enable RLS in a migration that only replaces a policy', () => {
    // Harmless as SQL — the statement is idempotent — and misleading as a
    // record: a reader would take this file for the place isolation begins.
    expect(rlsMigrationSql('0036_outbox_poller_rls')).not.toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('leaves 0025 describing what 0025 actually applied', () => {
    /*
     * The superseding entry must not rewrite history. A database that ran 0025
     * got the boilerplate policy, and the file has to keep saying so — the
     * whole reason a later policy needs its own migration.
     */
    expect(rlsMigrationSql()).toContain('CREATE POLICY tenant_isolation ON outbox');
    expect(rlsMigrationSql()).not.toContain('app.outbox_poller');
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

  describe('the widget scope (P2-07, ADR 0022)', () => {
    const WIDGET_TABLES = ['widget_keys', 'tenant_domains', 'tenants'] as const;
    const current = (table: string) => RLS_POLICIES.filter((p) => p.table === table).at(-1);

    it('keeps the widget branches out of WITH CHECK on all three tables', () => {
      /*
       * The widget scope must buy a read and nothing else. Its transaction is
       * read-only as well, but the policy holds the line on its own: a widget
       * GUC in WITH CHECK would let a write name any tenant the branch admits.
       */
      for (const table of WIDGET_TABLES) {
        /* `widget_keys` was superseded again by P4-10's secret-key branch;
         * the widget branch is still in it and must still be read-only. */
        expect(current(table)?.migration, table).toBe(
          table === 'widget_keys' ? '0049_secret_key_rls' : '0042_widget_key_rls',
        );
        expect(current(table)?.using, table).toContain('app.widget_');
        expect(current(table)?.withCheck, table).not.toContain('app.widget_');
        expect(current(table)?.withCheck, table).toContain("current_setting('app.tenant_id'");
      }
    });

    it("ties a domain to the presented key's own tenant, not to any holder of the origin", () => {
      const domains = current('tenant_domains')?.using ?? '';

      expect(domains).toContain("current_setting('app.widget_origin'");
      expect(domains).toContain('AND tenant_id IN (SELECT k.tenant_id FROM widget_keys k');
    });

    it('reaches a tenant row only behind a verified domain that belongs to the key', () => {
      const tenants = current('tenants')?.using ?? '';

      expect(tenants).toContain("d.status = 'VERIFIED'");
      expect(tenants).toContain("current_setting('app.widget_origin'");
      expect(tenants).toContain('FROM widget_keys k');
    });

    it('replaces the three policies and reverses each to the one it replaced', () => {
      const up = rlsMigrationSql('0042_widget_key_rls');
      const down = rlsDownSql('0042_widget_key_rls');

      for (const table of WIDGET_TABLES) {
        expect(up).toContain(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
        expect(down).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
      }

      expect(up).not.toContain('ENABLE ROW LEVEL SECURITY');
      expect(up.match(/CREATE POLICY (\w+)/g)).toEqual([
        'CREATE POLICY tenant_isolation',
        'CREATE POLICY tenant_isolation',
        'CREATE POLICY tenant_isolation',
      ]);
      expect(down).not.toContain('app.widget_');
      expect(down).not.toContain('DISABLE ROW LEVEL SECURITY');
    });
  });
});

describe('the secret-key scope (P4-10, ADR 0026)', () => {
  const keys = (): { using: string; withCheck: string } => {
    const policy = [...RLS_POLICIES].reverse().find((entry) => entry.table === 'widget_keys');

    return { using: policy?.using ?? '', withCheck: policy?.withCheck ?? policy?.using ?? '' };
  };

  it('admits a key row by its secret hash', () => {
    expect(keys().using).toContain("current_setting('app.secret_key_hash'");
  });

  it('admits only the active row, never one rotated away from', () => {
    /*
     * **Load-bearing.** A public-key rotation carries the secret hash onto the
     * new row and the revoked row keeps its copy through the grace window
     * (P4-08). Without this clause, a secret would still answer on a row that
     * has stopped being the key.
     */
    expect(keys().using).toMatch(
      /secret_key_hash = nullif\(current_setting\('app\.secret_key_hash', true\), ''\) AND revoked_at IS NULL/u,
    );
  });

  it('keeps the secret branch out of WITH CHECK', () => {
    /* The scope buys a read of one row. A secret GUC in WITH CHECK would let a
     * write name the tenant the branch admits. */
    expect(keys().withCheck).not.toContain('app.secret_key_hash');
    expect(keys().withCheck).toContain("current_setting('app.tenant_id'");
  });

  it('adds a branch to widget_keys and to no other table', () => {
    /* It finds the tenant and hands over to the ordinary tenant policy. A
     * second table with a secret branch would be a second place it could reach. */
    const others = RLS_POLICIES.filter(
      (entry) => entry.table !== 'widget_keys' && entry.using.includes('app.secret_key_hash'),
    );

    expect(others).toEqual([]);
  });
});
