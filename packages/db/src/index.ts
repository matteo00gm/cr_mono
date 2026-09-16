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
 * The widget's resolution scope and its one accessor (P2-07).
 *
 * The fifth RLS context, and the only one that cannot write: its transaction is
 * `READ ONLY`. A public key and a normalised origin admit one key row, that
 * key's tenant's matching domain, and the tenant only behind a verified domain.
 * ADR 0022 records why it exists and what it costs.
 */
export {
  InvalidWidgetScopeError,
  NestedWidgetContextError,
  WIDGET_KEY_GUC,
  WIDGET_ORIGIN_GUC,
  withWidgetKey,
} from './with-widget-key.js';
export { resolveTenantByKeyAndOrigin, type WidgetResolution } from './widget-resolution.js';

/**
 * The widget token revocation read (P2-12a) and the sweep that clears them (P2-14).
 *
 * The read is not a context of its own: it runs under `withTenant`, for the
 * tenant a request resolved. The sweep is the **sixth** context, and ADR 0023:
 * `withLapsedRevocations` admits every tenant's revocations, but only those whose
 * token lapsed more than `REVOCATION_SWEEP_GRACE_SEC` ago, and it cannot write.
 * The rows are written when a domain is removed (P4-06).
 */
export { isTokenRevoked, pruneLapsedRevocations } from './token-revocations.js';

/**
 * The `security_events` writer and its count (P2-16).
 *
 * A statement module like the audit insert, with one difference written into
 * it: it opens its own transaction, because a refusal has to be recorded even
 * when the request that caused it rolls back.
 */
export {
  countSecurityEvents,
  insertSecurityEvent,
  type SecurityEvent,
  type SecurityEventQuery,
  type SecurityEventType,
} from './security-events.js';
export { REVOCATION_SWEEP_GRACE_SEC } from './revocation-grace.js';
export { REVOCATION_SWEEPER_GUC, withLapsedRevocations } from './with-lapsed-revocations.js';

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
  MAX_FIXED_WINDOW_SEC,
  PRUNE_BATCH,
  pruneClosedWindows,
  type BucketCheck,
  type BucketResult,
} from './rate-limit.js';

/**
 * The inbound-webhook idempotency ledger (P0-64b, and P0-33 after it).
 *
 * `withWebhookEvent` opens its own transaction, which every other export here
 * deliberately does not — and the reason it is allowed to is written at length
 * in the module: a webhook arrives outside any request, and both tables it
 * touches are global by design with no policy for a missing context to narrow.
 * It is exported rather than a `getDb` accessor for exactly that reason: one
 * named path with a written reason, never a general one that erodes into the
 * default.
 */
export {
  claimWebhookEvent,
  withWebhookEvent,
  type ClaimedRun,
  type WebhookEvent,
} from './webhooks.js';

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
  archiveProduct,
  countQueuedEmbeddings,
  EMBEDDING_EVENT,
  enqueueEmbedding,
  insertProduct,
  reindexCatalogue,
  reindexProduct,
  updateProduct,
  type CatalogueReindexOutcome,
  type CatalogueReindexRequest,
  type NewProduct,
  type ProductArchiveOutcome,
  type ProductPatch,
  type ProductReindexOutcome,
  type ProductRow,
  type ProductUpdateOutcome,
  type ProductWriteOutcome,
  type ReindexRequest,
} from './products.js';
export {
  planUpsert,
  previewUpsert,
  upsertProducts,
  WRITTEN_FIELDS,
  type PreviewOutcome,
  type PreviewRequest,
  type UpsertDecision,
  type UpsertOutcome,
  type UpsertRequest,
  type UpsertRow,
} from './products-upsert.js';

/**
 * Import attempts, keyed so a repeat applies once (P1-26).
 *
 * Two statements rather than one function wrapping the import, because the
 * claim has to commit before the import starts: a repeat arriving while it runs
 * can only see a committed claim. The API sequences them.
 */
export {
  claimImportRun,
  completeImportRun,
  IMPORT_CLAIM_EXPIRES_AFTER_SECONDS,
  type ImportRunClaim,
  type ImportRunRequest,
} from './import-runs.js';

/**
 * Catalogue reads (P1-06).
 *
 * Keyset pagination rather than `OFFSET`, and the sortable columns are an
 * allowlist mapping to column objects — so a client-supplied name has no column
 * to reach rather than being interpolated into SQL. Search (P1-08) and filters
 * (P1-09) compose into the same builder.
 */
export {
  DEFAULT_LIMIT,
  decodeCursor,
  EMBEDDING_STATES,
  isSortField,
  listProducts,
  MAX_LIMIT,
  productsByIds,
  SORTABLE,
  STOCK_STATUSES,
  type EmbeddingState,
  type ListQuery,
  type MatchMode,
  type ProductPage,
  type SortDirection,
  type SortField,
  type StockStatus,
} from './products-read.js';

/**
 * The completeness filter's SQL half (P1-09, deferred there until P1-12).
 *
 * **The weights are not here**, and that is the design: `packages/core` owns
 * what a field is worth, this package owns which column holds it, and the API
 * — the only layer that may import both — joins them. Writing the weights in
 * SQL as well would be the failure `completeness.ts` opens by naming, that a
 * score computed twice disagrees with itself in front of the seller.
 */
export {
  completenessExpression,
  type CompletenessFilter,
  type CompletenessWeight,
} from './products-read.js';

/**
 * The outbox drain (P1-31), and the scope it needs.
 *
 * **`withOutbox` is not another `withUser`.** The two contexts exported above
 * narrow to the caller's own rows; this one admits every tenant's outbox rows
 * at once, because draining a queue for the whole platform has no tenant to be
 * scoped to. It is exported by name, from here, rather than hidden behind a
 * subpath — the same decision `@catalogorosso/db/auth` did *not* get — because
 * what it unlocks is one table whose rows carry ids and an event name, and the
 * worker re-enters `withTenant` before it reads anything a seller wrote. The
 * argument for that, and the alternatives it rejects, are in `with-outbox.ts`.
 *
 * `runOutboxPass` is the sequence worth having as one function: claim, publish,
 * release, in a transaction and in that order. Marking before sending loses
 * jobs on a crash, and that mistake has no failing test.
 */
export { OUTBOX_POLLER_GUC, withOutbox } from './with-outbox.js';

export {
  CLAIM_LIMIT,
  claimOutboxJobs,
  countStuckJobs,
  markOutboxPublished,
  MAX_PUBLISH_ATTEMPTS,
  recordPublishFailure,
  runOutboxPass,
  type OutboxJob,
  type OutboxPass,
} from './outbox.js';

/**
 * Reading a product for embedding and writing the vector back (P1-37).
 *
 * Same terms as the other statement modules: they write SQL and take the
 * transaction from their caller, so nothing here reaches a connection. The
 * decision about *what* text a wine becomes, and whether it is worth
 * re-embedding, stays in `packages/core/src/rag`.
 */
export {
  activeEmbeddingVersionFilter,
  CURRENT_EMBEDDING_VERSION,
  EMBEDDING_CHUNK,
  missingForEmbeddingVersion,
  readActiveEmbeddingVersion,
  readProductForEmbedding,
  switchEmbeddingVersion,
  upsertEmbedding,
  writeEmbeddingStatus,
  type EmbeddableRow,
  type EmbeddingVersionSwitch,
  type EmbeddingStatusWrite,
  type StoredEmbedding,
} from './embeddings.js';

/**
 * Recording a turn (P2-30).
 *
 * Here rather than in `packages/core/src/conversations.ts` where the row puts
 * it, for the reason every statement module is here: queries live where the
 * driver is (P0-09). It takes the caller's transaction so the turn and P2-31's
 * `usage_events` row are one write.
 */
export {
  readConversation,
  recordTurn,
  type RecordedMessage,
  type RecordedTurn,
  type TurnToRecord,
} from './conversations.js';

/**
 * Retrieval against the catalogue (P2-18, §4.4).
 *
 * Here rather than in `packages/core/src/rag/` where the row puts it, for the
 * reason every statement module is here: queries live where the driver is
 * (P0-09). What is pure about retrieval — fusion, filters, the candidate cap —
 * stays in `packages/core`, and each of these takes the caller's transaction so
 * a whole retrieval is one `withTenant` on one connection.
 */
export {
  fusedSearch,
  FUSED_CANDIDATE_LIMIT,
  lexicalSearch,
  LEXICAL_CANDIDATE_LIMIT,
  RRF_K,
  vectorSearch,
  VECTOR_CANDIDATE_LIMIT,
  type FusedCandidate,
  type FusedSearchRequest,
  type LexicalCandidate,
  type LexicalSearchRequest,
  type VectorCandidate,
  type VectorSearchRequest,
} from './retrieval.js';
