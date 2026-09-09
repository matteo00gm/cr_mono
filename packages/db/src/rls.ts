/**
 * Row-level security policies, generated from a list rather than hand-written
 * (P0-37).
 *
 * This is what makes a forgotten `WHERE tenant_id = …` non-fatal. Everything
 * else in the security plan is defence in depth around it.
 *
 * **Generated, because the realistic failure is omission.** Nobody disables RLS
 * on purpose; someone adds a table and does not know this exists. A list in
 * code can be diffed, and `rls.test.ts` regenerates the SQL and compares it to
 * the committed migration, so adding a table here without regenerating fails in
 * CI. P0-41 then closes the loop from the other side, asking the database which
 * tables carry a policy.
 */

/**
 * The tenant comparison, wrapped in `nullif`.
 *
 * `current_setting(..., true)` returns null when unset — and **empty string**
 * once a transaction that set it has ended. Casting `''` to uuid raises 22P02,
 * so without the `nullif` a query outside `withTenant` fails with a type error
 * instead of returning nothing. Failing closed is the intent; failing loudly
 * with the wrong error is how that intent gets misread as a bug and "fixed".
 */
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/** The same read for the user GUC, which is text rather than uuid. */
const USER = "nullif(current_setting('app.user_id', true), '')";

/**
 * The invitation token's hash, set by `withInvitation` (P0-51).
 *
 * A third GUC, and the same argument as `app.user_id`: the acceptance path
 * reads `invitations` *before* the caller has a membership in that tenant —
 * that is what accepting means — so the tenant-scoped policy returns zero rows
 * on the one path that has to work. The alternative was an un-scoped
 * connection, which would put a second table outside RLS to solve a problem
 * inside it.
 *
 * What makes this safe is that the value is a 256-bit secret, not an
 * identifier: holding it *is* the authorization, and a caller who does not hold
 * it matches no row. Contrast `app.tenant_id`, which a request must never be
 * able to choose.
 */
const INVITATION = "nullif(current_setting('app.invitation_token', true), '')";

/**
 * The outbox poller's flag (P1-31), and the **fourth** GUC.
 *
 * What makes this one different from the two above is worth saying plainly,
 * because the difference is the whole risk. `app.user_id` and
 * `app.invitation_token` *narrow*: each admits the rows belonging to the caller
 * and nothing else, so a caller with the wrong value sees less, never more.
 * This one does not narrow. **It is a read across every tenant**, because the
 * poller drains the queue for the whole platform in one pass — there is no
 * tenant to scope it to, and asking "which tenants have work" is itself the
 * cross-tenant read. The alternative was a transaction per tenant per minute,
 * forever, over mostly-empty queues.
 *
 * **So it appears in `USING` and never in `WITH CHECK`**, which is the same
 * decision `memberships` made about `app.user_id` and for a stronger reason
 * here: the poller's release is an UPDATE, and requiring it to satisfy the
 * tenant branch means the poller must set `app.tenant_id` from the row it
 * claimed before it writes. Which it does — `runOutboxPass` groups its
 * releases by tenant and scopes each one. The flag therefore buys a read and
 * nothing else: it cannot insert a job naming another tenant, and it cannot
 * delete one, because both of those need a tenant this context does not have.
 *
 * What is left bounded is a read of one table, whose rows carry a tenant id, a
 * product id, an event name and a one-word reason (`enqueueEmbedding` in
 * `products.ts`) — so what crosses the boundary is the *fact* that a tenant
 * edited something, never what they edited. The worker re-enters `withTenant`
 * before it reads a product, so nothing downstream inherits the unlock.
 *
 * A flag rather than a secret, deliberately. A secret would have to be stored
 * where the poller can read it, which is where anyone who can call
 * `set_config` can read it too — it would look like authorization and be
 * nothing of the kind. `withInvitation`'s token is a secret held by the *user*,
 * which is a different thing entirely.
 */
const POLLER = "nullif(current_setting('app.outbox_poller', true), '') = 'on'";

export interface RlsPolicy {
  /** Table the policy is attached to. */
  readonly table: string;
  /**
   * True when this entry **replaces** an earlier entry's policy on the same
   * table, in a later migration.
   *
   * A second *policy* is never the answer, and `rls-coverage.integration.test`
   * says so against a live database: permissive policies are OR-ed, so adding
   * one for a plausible reason does not modify `tenant_isolation`, it bypasses
   * it — and every existing isolation test still passes, because they only ever
   * assert what one tenant can see. So a policy that needs to change is dropped
   * and re-created under the same name.
   *
   * It changes both directions. The up drops the old policy first and does not
   * claim to enable RLS, which is already on. The down re-creates the *previous*
   * entry's definition rather than disabling anything — reversing this
   * migration has to leave the table exactly as protected as it found it, and
   * a generated `DISABLE ROW LEVEL SECURITY` here would strip isolation from a
   * table this migration only meant to adjust.
   */
  readonly supersedes?: boolean;
  /** Rows this role may see. */
  readonly using: string;
  /** Rows this role may write. Defaults to `using` where they agree. */
  readonly withCheck?: string;
  /** Why this table departs from the boilerplate, if it does. */
  readonly note?: string;
  /**
   * Which migration file carries this policy.
   *
   * Defaults to P0-37's original. It exists because a table added *after* that
   * migration cannot have its policy appended to it: `0025_rls.sql` is applied
   * history, and editing it would mean a database that already ran it never
   * gets the new policy while the file claims otherwise. So the list stays the
   * single source of truth for which policies exist, and this field records
   * which file each one shipped in.
   */
  readonly migration?: string;
}

/** P0-37's original migration, and the default for anything without a tag. */
export const BASE_RLS_MIGRATION = '0025_rls';

/**
 * The header each generated file carries.
 *
 * Per migration rather than one constant, because the task that owns a policy
 * is the first thing a reader of the SQL wants: a file headed "P0-37" that
 * creates the invitations policy sends them to the wrong section of the plan.
 */
const HEADERS: Readonly<Record<string, string>> = {
  '0025_rls': 'Row-level security (P0-37).',
  '0033_invitations_rls': 'Row-level security for invitations (P0-51).',
  '0036_outbox_poller_rls': 'The outbox poller reads across tenants (P1-31).',
};

/** Every migration file this list generates, in first-appearance order. */
export const rlsMigrations = (): readonly string[] => [
  ...new Set(RLS_POLICIES.map((policy) => policy.migration ?? BASE_RLS_MIGRATION)),
];

const forMigration = (migration: string): readonly RlsPolicy[] =>
  RLS_POLICIES.filter((policy) => (policy.migration ?? BASE_RLS_MIGRATION) === migration);

/**
 * The entry this one replaces, for the reverse direction.
 *
 * Found by position rather than recorded by hand: the previous definition of a
 * table's policy is the previous entry for that table, and writing it out twice
 * is how a down file comes to restore something that was never there.
 */
const supersededBy = (policy: RlsPolicy): RlsPolicy | undefined => {
  const index = RLS_POLICIES.indexOf(policy);

  return [...RLS_POLICIES.slice(0, index)].reverse().find((p) => p.table === policy.table);
};

const boilerplate = (table: string): RlsPolicy => ({
  table,
  using: `tenant_id = ${TENANT}`,
});

/**
 * Every table carrying a policy, in migration order.
 *
 * Three are not the boilerplate, and each says why. `processed_webhooks`,
 * `rate_limit_buckets` and `email_suppressions` are absent on purpose: none has
 * a `tenant_id`, so there is nothing to scope them by — see their schema
 * modules. For `email_suppressions` (P0-64) the absence is the protection
 * rather than a gap in it: the sending reputation a suppression defends belongs
 * to the domain, so a bounce one tenant caused has to stop every tenant.
 */
export const RLS_POLICIES: readonly RlsPolicy[] = [
  {
    table: 'tenants',
    using: `id = ${TENANT}`,
    note:
      'No tenant_id column — it *is* the tenant. Every runtime read happens with ' +
      'context already set, so the policy costs nothing and closes the hole of a bug ' +
      'enumerating every tenant. Signup creates a tenant before context exists, so it ' +
      'generates the id in the application and opens the transaction with withTenant(newId).',
  },
  {
    table: 'memberships',
    using: `tenant_id = ${TENANT}\n    OR user_id = ${USER}`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'Tenant resolution reads this table before a tenant is known, so the boilerplate ' +
      'returns zero rows on the login path. A second GUC rather than an un-scoped read, ' +
      'so every runtime query stays under RLS. WITH CHECK stays tenant-only: including ' +
      'user_id there would let any authenticated user insert a membership for themselves ' +
      'into any tenant.',
  },
  {
    table: 'invitations',
    migration: '0033_invitations_rls',
    using: `tenant_id = ${TENANT}
    OR token_hash = ${INVITATION}`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'Acceptance reads this table before the caller is a member of the tenant, which is what ' +
      'accepting means, so the boilerplate returns zero rows on the one path that must work. ' +
      'The token branch is safe where a tenant branch would not be because the value is a ' +
      '256-bit secret rather than an identifier: holding it is the authorization. WITH CHECK ' +
      'stays tenant-only, so nobody can insert an invitation into a tenant they are not in.',
  },
  boilerplate('tenant_domains'),
  boilerplate('widget_keys'),
  boilerplate('products'),
  boilerplate('product_embeddings'),
  boilerplate('conversations'),
  boilerplate('messages'),
  boilerplate('widget_events'),
  boilerplate('usage_events'),
  boilerplate('usage_daily'),
  boilerplate('audit_log'),
  {
    table: 'security_events',
    using: `tenant_id = ${TENANT}`,
    withCheck: `tenant_id IS NULL\n    OR tenant_id = ${TENANT}`,
    note:
      'tenant_id is nullable: an INVALID_KEY rejection matched no tenant, which is why ' +
      'it was rejected. The boilerplate WITH CHECK rejects those rows outright — the ' +
      'comparison is null and WITH CHECK requires true — so the application would fail ' +
      'to record an attack at the moment it is under one. USING stays strict, leaving ' +
      'unattributed rows to app_admin.',
  },
  boilerplate('token_revocations'),
  boilerplate('outbox'),
  {
    table: 'outbox',
    migration: '0036_outbox_poller_rls',
    supersedes: true,
    using: `tenant_id = ${TENANT}
    OR ${POLLER}`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'The poller drains every tenant’s queue in one pass, so there is no tenant to scope ' +
      'it to and the boilerplate returns zero rows — silently, which is the failure this ' +
      'would actually have had. Unlike the user and invitation branches above, this branch ' +
      'does not narrow to the caller’s own rows: it is a read across every tenant, of a ' +
      'table whose rows carry ids, an event name and a one-word reason rather than anything ' +
      'a seller wrote. WITH CHECK stays tenant-only, exactly as memberships does, and here it ' +
      'does more work: the poller’s release is an UPDATE, so it has to set app.tenant_id ' +
      'from the row it claimed before it writes. The flag therefore buys a read and nothing ' +
      'else — no insert of a job naming another tenant, and no delete of one.',
  },
];

/**
 * Renders the migration.
 *
 * `FORCE` as well as `ENABLE`: without it the table owner bypasses the policy,
 * and `app_migrate` owns every table here. `WITH CHECK` as well as `USING`:
 * `USING` filters reads, and without `WITH CHECK` a bug could still *insert* a
 * row carrying another tenant's id.
 */
export const rlsMigrationSql = (migration: string = BASE_RLS_MIGRATION): string => {
  const header = [
    `-- ${HEADERS[migration] ?? 'Row-level security (P0-37).'}`,
    '--',
    '-- Generated by `rlsMigrationSql()` in src/rls.ts. Do not edit by hand:',
    '-- `test/rls.test.ts` regenerates this file and fails if the two disagree,',
    '-- which is what stops a table being added to the list and not to the database.',
  ].join('\n');

  const blocks = forMigration(migration).map((policy) => {
    const note = policy.note
      ? policy.note
          .split(/(?<=\.) (?=[A-Z])/)
          .map((line) => `-- ${line}`)
          .join('\n') + '\n'
      : '';

    const withCheck = policy.withCheck ?? policy.using;

    /*
     * A superseding entry adjusts a policy that already exists. RLS is already
     * on — saying so again would be a no-op and a misleading one — and the old
     * definition has to go before the new one can take its name.
     */
    const head = policy.supersedes
      ? [`DROP POLICY IF EXISTS tenant_isolation ON ${policy.table};`]
      : [
          `ALTER TABLE ${policy.table} ENABLE ROW LEVEL SECURITY;`,
          `ALTER TABLE ${policy.table} FORCE ROW LEVEL SECURITY;`,
        ];

    const lines = [
      ...head,
      `CREATE POLICY tenant_isolation ON ${policy.table}`,
      `  USING (${policy.using})`,
      `  WITH CHECK (${withCheck});`,
    ];

    return note + lines.join('\n');
  });

  return `${header}\n\n${blocks.join('\n--> statement-breakpoint\n')}\n`;
};

/** Reverses one migration's policies, in the same order. */
export const rlsDownSql = (migration: string = BASE_RLS_MIGRATION): string =>
  [
    `-- Reverses ${migration}.sql.`,
    '',
    forMigration(migration)
      .map((policy) => {
        const previous = policy.supersedes ? supersededBy(policy) : undefined;

        /*
         * A superseding policy reverses to the definition it replaced, not to
         * nothing. Dropping it and stopping there would leave the table with no
         * policy at all while RLS stayed forced — every query returning zero
         * rows — and emitting the disable instead would leave it with no
         * isolation. Both are silent; the second is the dangerous one.
         */
        if (previous !== undefined) {
          return [
            `DROP POLICY IF EXISTS tenant_isolation ON ${policy.table};`,
            `CREATE POLICY tenant_isolation ON ${policy.table}`,
            `  USING (${previous.using})`,
            `  WITH CHECK (${previous.withCheck ?? previous.using});`,
          ].join('\n');
        }

        return [
          `DROP POLICY IF EXISTS tenant_isolation ON ${policy.table};`,
          `ALTER TABLE ${policy.table} NO FORCE ROW LEVEL SECURITY;`,
          `ALTER TABLE ${policy.table} DISABLE ROW LEVEL SECURITY;`,
        ].join('\n');
      })
      .join('\n\n'),
    '',
  ].join('\n');
