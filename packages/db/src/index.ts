/**
 * Public surface of `@catalogorosso/db`.
 *
 * `withTenant` is the only sanctioned way to reach the database (P0-19), and
 * that has to hold at the *export* surface, not just the import one. Re-exporting
 * `getDb`/`getSql`/`createDbClient` from here would let any app write
 * `import { getDb } from '@catalogorosso/db'` and issue queries with no tenant
 * context — no dependency rule can catch that, because the app would be
 * importing this package rather than the driver.
 *
 * The connection factory stays internal to the package. When a genuinely
 * un-scoped path is needed — migrations as `app_migrate`, or the Better Auth
 * adapter reading `auth_*` tables before a tenant is known (§P0-45) — it gets
 * its own narrowly-named export with a written reason, rather than a general
 * accessor that erodes into the default.
 */
export {
  getCurrentTenantId,
  InvalidTenantIdError,
  NestedTenantContextError,
  withTenant,
  type DbTransaction,
} from './with-tenant.js';

/**
 * The user-scoped read for tenant resolution (P0-47).
 *
 * Exported from here alongside `withTenant` rather than hidden behind a
 * subpath, because it is **not** an exception to the rule above — it is a
 * second scoped context, and everything it can reach is still under RLS. The
 * `memberships` policy admits `user_id = app.user_id` on read and nothing else
 * does, so this context can see exactly the caller's own membership rows.
 * Contrast `@catalogorosso/db/auth`, which really does hand out an un-scoped
 * connection and is therefore gated by the P0-09 rule.
 */
export { InvalidUserIdError, NestedUserContextError, withUser } from './with-user.js';

/**
 * The membership read itself, so no app has to write the query.
 *
 * It lives here rather than in `apps/api` because writing it there would mean
 * the app importing `drizzle-orm`, which the P0-09 rule forbids — and the right
 * answer to that was to put the query where queries belong, not to add an
 * exception. The decision made *with* these rows stays in `packages/core`,
 * which has no database at all.
 */
export {
  readMembershipsForUser,
  readRoster,
  type MembershipRole,
  type RosterEntry,
  type UserMembership,
} from './memberships.js';

/**
 * The audit insert (P0-53).
 *
 * Same reasoning as the membership read above: the statement lives in this
 * package so no app or domain module has to import a driver. What gets
 * recorded, and what is scrubbed out of it, stays in `packages/core`.
 */
export { insertAuditRow, type AuditRow } from './audit.js';

export type { Database } from './client.js';

/**
 * The request and response contracts (P0-42).
 *
 * Exported from here rather than reached for by deep import, so the widget, the
 * dashboard and the API all validate against the same shapes — the point of
 * deriving them at all. They carry no connection and open nothing, so they do
 * not weaken the `withTenant`-only rule above.
 */
export * from './contracts.js';

/**
 * The deploy-time path (P0-21b), and the one narrowly-named un-scoped export
 * this file's header anticipates.
 *
 * These apply bootstrap and migrations as the roles that own the schema, before
 * any tenant row exists — there is no tenant context to carry and no policy for
 * one to satisfy, so `withTenant` would have nothing to say. Exported because
 * both a deploy and the P0-44 harness need them, and a second copy of the
 * applying logic is exactly what the P0-21 grant bug came from.
 */
export {
  applyBootstrap,
  applyMigrations,
  revertMigrations,
  withRole,
  type BootstrapRole,
  type SqlLocation,
} from './deploy.js';

/**
 * The email suppression list (P0-64).
 *
 * Same reasoning as the audit insert above. The table is global rather than
 * tenant-scoped — a bounce is a fact about an address, and the reputation it
 * protects is the sending domain's — so these carry no tenant context and
 * `withTenant` has nothing to scope. What that means for a send, and what the
 * caller is told when one is refused, lives in `packages/core`.
 */
export {
  isSuppressed,
  suppressAddress,
  unsuppressAddress,
  type SuppressionRow,
} from './email-suppressions.js';

/**
 * The invitation acceptance scope (P0-51).
 *
 * The third RLS context, beside `withTenant` and `withUser`, and exported for
 * the same reason: it is a *scoped* path, not an escape from scoping. The
 * invitation is matched by a 256-bit secret and the tenant is then set from the
 * row Postgres returned — so the membership it writes is scoped by a value that
 * came out of the database rather than off the wire, on the one path that has
 * no membership to read it from.
 */
export { withInvitation, type OpenInvitation } from './with-invitation.js';

/**
 * The `invitations` statements (P0-51).
 *
 * Here rather than in an app for the same reason as the audit insert and the
 * membership read: statements live in this package so no app imports a driver.
 * Which role an invitation carries, and whether an acceptance is admitted, stay
 * in `packages/core`.
 */
export {
  emailIsMember,
  insertInvitation,
  insertMembershipFromInvitation,
  markInvitationAccepted,
  readActiveTenantName,
  type NewInvitation,
} from './invitations.js';

/**
 * Reads an address for a user id, for the invitation email check (P0-51).
 *
 * `auth_users` carries no `tenant_id` and no policy — it is read before a
 * tenant is known, by design (§P0-45) — so this is a plain read inside whatever
 * transaction the caller already holds.
 */
export { readUserEmail } from './users.js';

/**
 * Membership changes, with the last-OWNER guard in the statement (P0-52).
 *
 * Exported as the *only* way to change or remove a membership. A caller that
 * writes its own `UPDATE memberships` has bypassed the guard, which is why the
 * condition lives in the statement rather than in a helper beside it — and why
 * the outcome is returned rather than thrown: what a refusal means to a caller
 * is HTTP-shaped, and this package has no HTTP.
 */
export {
  countOwners,
  removeMember,
  setMemberRole,
  type MemberWriteOutcome,
} from './members-write.js';

/**
 * The members screen's reads and the invitation withdrawal (E8).
 *
 * Same reasoning as every other statement exported here: queries live in this
 * package so no app imports a driver. What a caller is *allowed* to do with
 * them — the capability, the last-OWNER guard, the audit row — stays where
 * those decisions belong.
 */
export { readOpenInvitations, revokeInvitation, type PendingInvitation } from './invitations.js';

/**
 * The Postgres rate limiter (P2-02), which is what closes A1.
 *
 * Here rather than in `packages/security` where P2-02's Files line puts it, and
 * the deviation follows this package's own rule: statements live where queries
 * belong, so no domain module imports a driver (P0-09). The *interface* stays
 * in `packages/security` beside the capability table, which is the security
 * vocabulary the rest of the repository compiles against.
 */
export {
  BucketsExceeded,
  consumeBuckets,
  createRateLimiter,
  pruneClosedWindows,
  type BucketCheck,
  type BucketResult,
} from './rate-limit.js';

/**
 * The catalogue write statements (P1-02).
 *
 * `insertProduct` writes the product **and** its outbox row, which is why it is
 * one export rather than two: §4.1's guarantee is that a committed product
 * always has a queued embedding job, and two calls left in a caller's hands is
 * a convention rather than a guarantee. What a duplicate SKU means over HTTP
 * stays in `apps/api`; this returns an outcome.
 */
export {
  EMBEDDING_EVENT,
  enqueueEmbedding,
  insertProduct,
  type NewProduct,
  type ProductRow,
  type ProductWriteOutcome,
} from './products.js';
