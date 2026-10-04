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

import { REVOCATION_SWEEP_GRACE_SEC } from './revocation-grace.js';

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

/**
 * The revocation sweep's flag (P2-14) — the **sixth** context, and ADR 0023.
 *
 * It widens across tenants, as the poller's does: the sweep deletes lapsed
 * revocations for the whole platform in one statement. Unlike the poller's,
 * **its branch carries a row predicate**, so the flag never admits a revocation
 * on its own — only one whose token lapsed more than the continuation window ago
 * (P2-12a). What it can see and delete is exactly the rows that no longer refuse
 * anything, and a revocation that could still stop a continuing session is
 * invisible to it whatever the statement asks for.
 */
const SWEEPER = "nullif(current_setting('app.revocation_sweeper', true), '') = 'on'";
const LAPSED = `expires_at < now() - make_interval(secs => ${String(REVOCATION_SWEEP_GRACE_SEC)})`;

/**
 * The widget's public key and normalised origin, set by `withWidgetKey` (P2-07)
 * — the **fifth** context, and ADR 0022.
 *
 * Neither value is a secret: a public key sits in a script tag on the seller's
 * page and a verified origin is where that page lives. What bounds the scope is
 * how the branches below compose — a key reaches one key row, an origin reaches
 * only that key's tenant's domain, and the tenant row only behind a verified
 * domain — and that `withWidgetKey` opens its transaction `READ ONLY`, so
 * nothing admitted here can be written, whatever a policy says.
 */
const WIDGET_KEY = "nullif(current_setting('app.widget_key', true), '')";
const WIDGET_ORIGIN = "nullif(current_setting('app.widget_origin', true), '')";

/** The tenant that owns the presented key, read under `widget_keys`' own policy. */
const WIDGET_KEY_TENANT = `SELECT k.tenant_id FROM widget_keys k WHERE k.public_key = ${WIDGET_KEY}`;

/**
 * The secret-key scope's one GUC (P4-10, ADR 0026). Set only by
 * `resolveTenantBySecretKey`, which clears it again as soon as it has read the key's row.
 */
const SECRET_KEY_HASH = "nullif(current_setting('app.secret_key_hash', true), '')";

/**
 * The claim being settled, set by `settleDomainClaim` (P4-18, ADR 0028) — the
 * **eighth** context.
 *
 * An identifier, not a secret, and what bounds it is not the value but the row
 * it names: the branch below admits a domain only when the named claim is one
 * the current tenant can see under `domain_claims`' own policy, and only once
 * that claim has been proved, or its notice has run out. A claim still waiting
 * for its DNS proof, a notice with time left on it and a withdrawn claim all
 * admit nothing, whatever runs inside the scope.
 */
const CLAIM = "nullif(current_setting('app.domain_claim', true), '')::uuid";

/**
 * The claim sweep's flag (P4-18b, an amendment to ADR 0028).
 *
 * It widens across tenants, as the revocation sweep's does, and like that one
 * **its branch carries a row predicate**: it admits a claim on notice, and a
 * settled or withdrawn claim whose outcome has not been notified yet — the
 * work the sweep exists to do, and nothing else. A claim awaiting its proof,
 * and every claim whose last state has already been told, stay invisible.
 */
const CLAIM_SWEEPER = "nullif(current_setting('app.claim_sweeper', true), '') = 'on'";

/** The origin a settleable claim names, read under `domain_claims`' own policy. */
const SETTLEABLE_CLAIM_ORIGIN_0054 = `SELECT c.origin FROM domain_claims c
      WHERE c.id = ${CLAIM}
        AND (c.status = 'PROVEN'
          OR (c.status = 'NOTICE' AND c.transfer_at <= now()))`;

/** From P4-18b: a notice is settleable only once it has been sent. */
const SETTLEABLE_CLAIM_ORIGIN = `SELECT c.origin FROM domain_claims c
      WHERE c.id = ${CLAIM}
        AND (c.status = 'PROVEN'
          OR (c.status = 'NOTICE' AND c.notified_at IS NOT NULL AND c.transfer_at <= now()))`;

/** The tenants policy as P4-19b left it: the tenant, or the widget scope behind a domain or dev origin. */
const TENANTS_WIDGET_USING_0059 = `id = ${TENANT}
    OR id IN (SELECT d.tenant_id FROM tenant_domains d
      WHERE d.origin = ${WIDGET_ORIGIN} AND d.status = 'VERIFIED'
        AND d.tenant_id IN (${WIDGET_KEY_TENANT}))
    OR (dev_origin = ${WIDGET_ORIGIN}
      AND dev_mode_expires_at > now()
      AND id IN (${WIDGET_KEY_TENANT}))`;

/**
 * The tenant directory's flag (P5-13, ADR 0030): every tenant row, for a
 * read-only transaction that lists tenant ids and nothing else.
 */
const TENANT_DIRECTORY = "nullif(current_setting('app.tenant_directory', true), '') = 'on'";

/**
 * The shop a Shopify webhook names (P6-06, ADR 0031): one installation row,
 * for a read-only transaction that learns which winery holds it.
 */
const SHOPIFY_SHOP = "nullif(current_setting('app.shopify_shop', true), '')";

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
  '0040_import_runs_rls': 'Row-level security for import runs (P1-26).',
  '0042_widget_key_rls': 'The widget resolves its tenant from a key and an origin (P2-07).',
  '0043_revocation_sweep_rls': 'The sweep deletes lapsed token revocations across tenants (P2-14).',
  '0047_session_cutoffs_rls': 'Row-level security for session cutoffs (P4-06).',
  '0049_secret_key_rls': 'A server finds its tenant from a secret key (P4-10).',
  '0054_domain_claims_rls': 'A proven claim reaches the domain it names (P4-18).',
  '0056_domain_claim_sweep_rls':
    'The claim sweep finds its work, and a notice counts once sent (P4-18b).',
  '0059_dev_mode_rls':
    'A winery in development mode is reachable from its one local origin (P4-19b).',
  '0063_usage_top_ups_rls': 'Row-level security for message top-ups (P5-11a).',
  '0065_notification_events_rls': 'Row-level security for quota notices sent (P5-12).',
  '0069_tenant_directory_rls': 'The nightly rollup lists every tenant, read only (P5-13).',
  '0073_shopify_rls': 'A Shopify webhook finds its winery by shop, read only (P6-06).',
  '0068_e_invoices_rls': 'Row-level security for charges awaiting an e-invoice (P5-03a).',
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
  { ...boilerplate('import_runs'), migration: '0040_import_runs_rls' },
  {
    table: 'widget_keys',
    migration: '0042_widget_key_rls',
    supersedes: true,
    using: `tenant_id = ${TENANT}
    OR public_key = ${WIDGET_KEY}`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'The widget has to learn its tenant from the public key before any tenant is known, so ' +
      'the boilerplate returns zero rows on the one path that must work (P2-07, ADR 0022). ' +
      'The key branch admits exactly the presented key’s row, the key being unique. ' +
      'WITH CHECK stays tenant-only, and withWidgetKey opens its transaction READ ONLY, ' +
      'so the branch buys a read of one row and nothing else.',
  },
  {
    table: 'tenant_domains',
    migration: '0042_widget_key_rls',
    supersedes: true,
    using: `tenant_id = ${TENANT}
    OR (origin = ${WIDGET_ORIGIN}
      AND tenant_id IN (${WIDGET_KEY_TENANT}))`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'The same resolution needs the domain the request came from. The origin alone is not ' +
      'enough: the branch admits the domain only when it belongs to the presented key’s own ' +
      'tenant, so an origin verified by one winery is invisible to a key issued to another. ' +
      'WITH CHECK stays tenant-only, and the widget scope cannot write.',
  },
  {
    table: 'tenants',
    migration: '0042_widget_key_rls',
    supersedes: true,
    using: `id = ${TENANT}
    OR id IN (SELECT d.tenant_id FROM tenant_domains d
      WHERE d.origin = ${WIDGET_ORIGIN} AND d.status = 'VERIFIED'
        AND d.tenant_id IN (${WIDGET_KEY_TENANT}))`,
    withCheck: `id = ${TENANT}`,
    note:
      'The widget needs the tenant’s status, plan and locale once the pair agrees. The row is ' +
      'reachable only behind a VERIFIED domain whose tenant owns the presented key, so a key on ' +
      'its own, or a pending claim, never reaches a tenant row. WITH CHECK stays tenant-only, ' +
      'and the widget scope cannot write.',
  },
  {
    table: 'token_revocations',
    migration: '0043_revocation_sweep_rls',
    supersedes: true,
    using: `tenant_id = ${TENANT}
    OR (${SWEEPER}
      AND ${LAPSED})`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'The sweep deletes lapsed revocations for every tenant in one statement, so the ' +
      'boilerplate returns zero rows, silently, on the one path that has to reach all of them ' +
      '(P2-14, ADR 0023). The flag never admits a row on its own: only a revocation whose token ' +
      'lapsed more than the continuation window ago, so one that could still refuse a ' +
      'continuing session is invisible to it. WITH CHECK stays tenant-only, so the flag can ' +
      'neither write a revocation nor move one.',
  },
  {
    ...boilerplate('widget_session_cutoffs'),
    migration: '0047_session_cutoffs_rls',
    note:
      'Nothing but the boilerplate, and that is the whole point of where it is read (P4-06). A ' +
      'cutoff is consulted on the widget request path — but only after CORS has resolved the ' +
      'tenant from (pk_, Origin), so it is read inside an ordinary withTenant, exactly as ' +
      'isTokenRevoked reads token_revocations two checks earlier on the same request. No new ' +
      'GUC, no seventh context: the one thing a new table here could have cost, and did not.',
  },
  {
    table: 'widget_keys',
    migration: '0049_secret_key_rls',
    supersedes: true,
    using: `tenant_id = ${TENANT}
    OR public_key = ${WIDGET_KEY}
    OR (secret_key_hash = ${SECRET_KEY_HASH} AND revoked_at IS NULL)`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'A server presenting a secret key has no tenant yet, so the boilerplate returns zero rows on ' +
      'the one path that must find one (P4-10, ADR 0026). The branch admits exactly the active row ' +
      'whose hash is the one presented — and revoked_at IS NULL is load-bearing, because a public ' +
      'key rotation carries the hash onto the new row and the revoked one keeps its copy through ' +
      'the grace window (P4-08). resolveTenantBySecretKey clears the GUC as soon as it has read the row and ' +
      'continues as an ordinary tenant scope, READ ONLY. WITH CHECK stays tenant-only.',
  },
  {
    table: 'domain_claims',
    migration: '0054_domain_claims_rls',
    using: `tenant_id = ${TENANT}
    OR incumbent_tenant_id = ${TENANT}`,
    withCheck: `tenant_id = ${TENANT}
    OR (incumbent_tenant_id = ${TENANT} AND status = 'CANCELED')`,
    note:
      'Two tenants on one row (P4-18, ADR 0028). The claimant owns it, as tenant_id. The holder ' +
      'a proven claim has put on notice must see it too, or the notice could not be answered — ' +
      'so incumbent_tenant_id admits it once it is set, and it is set only with a notice. The ' +
      'holder writes exactly one thing, a withdrawal, so its half of WITH CHECK admits only a ' +
      'CANCELED row: a holder cannot write a live claim, least of all one naming somebody else ' +
      'as claimant.',
  },
  {
    table: 'tenant_domains',
    migration: '0054_domain_claims_rls',
    supersedes: true,
    using: `tenant_id = ${TENANT}
    OR (origin = ${WIDGET_ORIGIN}
      AND tenant_id IN (${WIDGET_KEY_TENANT}))
    OR origin IN (${SETTLEABLE_CLAIM_ORIGIN_0054})`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'Settling a claim has to find the holder of an origin, and RLS hides every other ' +
      'winery’s rows — which is correct everywhere else, and the reason P4-01 can only say ' +
      '"not available" (P4-18, ADR 0028). The branch admits the one domain whose origin a ' +
      'settleable claim names: a claim the current tenant can see, that has been proved by DNS, ' +
      'or whose notice has run out. A claim awaiting proof, a notice with time left and a ' +
      'withdrawn claim admit nothing. settleDomainClaim clears the GUC as soon as it has read ' +
      'the holder and continues under the holder’s ordinary tenant scope. WITH CHECK stays ' +
      'tenant-only.',
  },
  {
    table: 'domain_claims',
    migration: '0056_domain_claim_sweep_rls',
    supersedes: true,
    using: `tenant_id = ${TENANT}
    OR incumbent_tenant_id = ${TENANT}
    OR (${CLAIM_SWEEPER}
      AND (status = 'NOTICE'
        OR (status IN ('TRANSFERRED', 'CANCELED') AND notified_status IS DISTINCT FROM status)))`,
    withCheck: `tenant_id = ${TENANT}
    OR (incumbent_tenant_id = ${TENANT} AND status = 'CANCELED')`,
    note:
      'The claim sweep sends each notice, settles each notice that has run out, and tells both ' +
      'wineries how a claim ended — and learning which claims need any of that is itself the ' +
      'cross-tenant read (P4-18b, ADR 0028). The flag never admits a row on its own: only a ' +
      'claim on notice, or a settled or withdrawn one whose outcome has not been notified. A ' +
      'claim awaiting proof, and every claim already told, stay invisible to it. WITH CHECK is ' +
      'unchanged, so the flag buys a read; the sweep writes as the claimant or the holder.',
  },
  {
    table: 'tenant_domains',
    migration: '0056_domain_claim_sweep_rls',
    supersedes: true,
    using: `tenant_id = ${TENANT}
    OR (origin = ${WIDGET_ORIGIN}
      AND tenant_id IN (${WIDGET_KEY_TENANT}))
    OR origin IN (${SETTLEABLE_CLAIM_ORIGIN})`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'A notice now counts only once it has been sent (P4-18b). The branch still admits the ' +
      'domain a proven claim names, but a claim on notice reaches it only with notified_at set ' +
      'and transfer_at passed — so a holder nobody told cannot lose its origin, whatever the ' +
      'code settling it believes.',
  },
  {
    table: 'tenants',
    migration: '0059_dev_mode_rls',
    supersedes: true,
    using: TENANTS_WIDGET_USING_0059,
    withCheck: `id = ${TENANT}`,
    note:
      'Development mode (P4-19b): a seller’s developer serves the widget from one exact local ' +
      'origin for twenty-four hours. The branch admits the winery only for its own key, only from ' +
      'that exact origin, and only while dev_mode_expires_at is in the future — so the expiry is ' +
      'the database’s, and the grant ends on time whatever the code believes. WITH CHECK stays ' +
      'tenant-only, and the widget scope cannot write.',
  },
  { ...boilerplate('usage_top_ups'), migration: '0063_usage_top_ups_rls' },
  { ...boilerplate('notification_events'), migration: '0065_notification_events_rls' },
  { ...boilerplate('e_invoices'), migration: '0068_e_invoices_rls' },
  {
    table: 'tenants',
    migration: '0069_tenant_directory_rls',
    supersedes: true,
    using: `${TENANTS_WIDGET_USING_0059}
    OR ${TENANT_DIRECTORY}`,
    withCheck: `id = ${TENANT}`,
    note:
      'The nightly rollup (P5-13) writes a row for every tenant, each day, including days with ' +
      'nothing in them — so it has to know every tenant, and learning that is itself the read ' +
      'across tenants (ADR 0030). The branch admits every row, and what bounds it is where it is ' +
      'set: only listTenantDirectory sets it, inside a READ ONLY transaction, for one statement ' +
      'that selects the id and the creation time. WITH CHECK stays tenant-only, so even a writable ' +
      'transaction holding the flag could not move a row.',
  },
  {
    table: 'shopify_installations',
    migration: '0073_shopify_rls',
    using: `tenant_id = ${TENANT}
    OR shop = ${SHOPIFY_SHOP}`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'A Shopify webhook names its shop and nothing else (P6-06, ADR 0031), so the winery that ' +
      'holds the shop is learned from this table before any tenant is known. The branch admits ' +
      'the one row for the shop the flag names, on this table only, and only resolveTenantByShop ' +
      'sets it, inside a READ ONLY transaction, before handing over to withTenant. WITH CHECK ' +
      'stays tenant-only.',
  },
  {
    table: 'shopify_oauth_states',
    migration: '0073_shopify_rls',
    using: `tenant_id = ${TENANT}
    OR user_id = ${USER}`,
    withCheck: `tenant_id = ${TENANT}`,
    note:
      'The install callback is a redirect from Shopify and carries no tenant, so it finds the ' +
      'state in the scope of the member who started the install — the memberships argument, on ' +
      'one more table. It spends the state by deleting it, which only USING governs; WITH CHECK ' +
      'stays tenant-only, so the user scope cannot write a state naming any winery.',
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
