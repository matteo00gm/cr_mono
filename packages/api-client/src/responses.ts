import { z } from 'zod';

/**
 * The response shapes of the dashboard API (P0-63).
 *
 * **Shared, not generated.** The row asks for types generated from OpenAPI, and
 * that indirection buys nothing here while costing a generation step and a
 * drift check. Every consumer is TypeScript in this repository, so the same
 * schema module can be imported by the server that produces the response and by
 * the clients that consume it — and then a breaking change fails typecheck in
 * all three at build time, which is the property the row is actually after.
 *
 * They live in this package rather than in `apps/api` because the boundary
 * rules forbid a package importing an app, and both consumers are packages or
 * apps that must not depend on the API. The OpenAPI document is a third
 * projection of these same schemas, emitted by `scripts/gen-openapi.mjs`.
 *
 * A response shape belongs here. A *table* shape belongs in `packages/db` and
 * is derived with `drizzle-zod` (P0-42) — the two are not the same thing, and
 * conflating them is how a column rename becomes a public API change.
 */

/** Both `role` values, matching `packages/security`'s `ROLES`. */
export const roleSchema = z.enum(['OWNER', 'EDITOR']);

/** One winery a user belongs to, and what they may do there. */
export const membershipSchema = z.object({
  tenantId: z.string(),
  role: roleSchema,
});

export const surfaceResponse = z.object({ surface: z.literal('dashboard') });

export const meResponse = z.object({
  userId: z.string(),
  memberships: z.array(membershipSchema),
});

export const contextResponse = membershipSchema;

/**
 * The answer to an invite (P0-51).
 *
 * `created` is false when the address is already a member or already has an
 * open invitation. Reported rather than hidden behind a 409, because the
 * owner's intent — make sure this person can get in — is satisfied either way,
 * and a dashboard that has to explain a conflict that is not one is a worse
 * experience than one that says "already invited".
 */
export const inviteResponse = z.object({
  email: z.string(),
  created: z.boolean(),

  /**
   * *Why* nothing was created, when nothing was (E8).
   *
   * Held back deliberately in P0-51 — the port distinguished the three cases
   * and the response flattened them, because widening a contract before there
   * is a reader means guessing at the shape. The members screen is that reader,
   * so the reason ships with it: "already a member", "already invited" and
   * "we cannot deliver to that address" are three different things to tell an
   * owner, and the third is the one they would otherwise never learn.
   */
  outcome: z.enum(['invited', 'already-member', 'already-invited', 'undeliverable']),
});

/**
 * Timestamps cross the wire as ISO-8601 strings.
 *
 * `z.iso.datetime()` rather than `z.date()`: JSON has no date type, so a schema
 * claiming one would validate against what the *server* holds and not against
 * what a client actually receives — which is the difference the contract exists
 * to pin.
 */
const timestamp = z.iso.datetime();

/**
 * The roster (E8).
 *
 * Name and address rather than only a user id, because a members screen listing
 * opaque identifiers is not a members screen. Both come from `auth_users` via a
 * join that RLS already scopes to this tenant's memberships.
 */
export const rosterResponse = z.object({
  members: z.array(
    z.object({
      userId: z.string(),
      email: z.string(),
      name: z.string(),
      role: roleSchema,
      joinedAt: timestamp,
    }),
  ),
});

/**
 * Invitations still outstanding (E8).
 *
 * Open ones only — accepted and revoked rows are history, and a screen that
 * listed them would show an owner a growing list of things they cannot act on.
 * **No token and no hash**: the hash is the credential's shadow, and returning
 * it would hand anyone with `members:manage` material to attack offline for no
 * gain over revoking and re-inviting.
 */
export const pendingInvitationsResponse = z.object({
  invitations: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      role: roleSchema,
      invitedBy: z.string(),
      expiresAt: timestamp,
      createdAt: timestamp,
    }),
  ),
});

/** The membership as it now stands, so the screen need not re-fetch the roster. */
export const roleChangeResponse = z.object({
  userId: z.string(),
  role: roleSchema,
});

export const memberRemovedResponse = z.object({
  userId: z.string(),
  removed: z.literal(true),
});

export const invitationRevokedResponse = z.object({
  invitationId: z.string(),
  revoked: z.literal(true),
});

/**
 * What redeeming an invitation gives back.
 *
 * The membership as written, so the dashboard can switch straight into the new
 * winery instead of re-fetching `/me` and guessing which entry is new.
 */
export const acceptInviteResponse = membershipSchema;

export type Membership = z.infer<typeof membershipSchema>;
export type SurfaceResponse = z.infer<typeof surfaceResponse>;
export type MeResponse = z.infer<typeof meResponse>;
export type ContextResponse = z.infer<typeof contextResponse>;
export type InviteResponse = z.infer<typeof inviteResponse>;
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponse>;
export type RosterResponse = z.infer<typeof rosterResponse>;
export type PendingInvitationsResponse = z.infer<typeof pendingInvitationsResponse>;
export type RoleChangeResponse = z.infer<typeof roleChangeResponse>;
export type MemberRemovedResponse = z.infer<typeof memberRemovedResponse>;
export type InvitationRevokedResponse = z.infer<typeof invitationRevokedResponse>;
export type Product = z.infer<typeof productSchema>;

/**
 * A product as the API returns it (P1-02).
 *
 * **Written here rather than derived from `productSelect`, and the exception to
 * "refine, never redefine" is deliberate.** `drizzle-zod` describes the *table*:
 * `Date` objects, `numeric` as a string, and every column the server owns. What
 * crosses the wire is JSON — ISO strings for timestamps — so a response typed
 * from the table would be a contract the server cannot actually satisfy, and
 * both consumers would compile against a shape they never receive.
 *
 * The two are kept honest by `products.test.ts`, which asserts that every key
 * here exists on the table contract. A column renamed in the schema therefore
 * fails a test rather than silently producing a response field nothing fills.
 */
export const productSchema = z.object({
  id: z.string(),
  sku: z.string(),
  externalVariantId: z.string().nullable(),
  name: z.string(),
  producer: z.string().nullable(),
  vintage: z.number().int().nullable(),
  wineType: z.string(),
  grapeVarieties: z.array(z.string()).nullable(),
  region: z.string().nullable(),
  denomination: z.string().nullable(),
  styleTags: z.array(z.string()).nullable(),
  tastingNotes: z.string().nullable(),
  foodPairings: z.array(z.string()).nullable(),
  /** `numeric` crosses the wire as a string, so 13.50 round-trips exactly. */
  alcoholPct: z.string().nullable(),
  priceCents: z.number().int(),
  currency: z.string(),
  stockStatus: z.enum(['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER']),
  stockQty: z.number().int().nullable(),
  productUrl: z.string().nullable(),
  imageUrl: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  /**
   * Reported, because it is the answer to the question a seller actually asks
   * after saving: "is this wine findable yet?" (P1-40 renders it in the grid.)
   */
  embeddingState: z.enum(['PENDING', 'INDEXED', 'FAILED', 'STALE']),

  /**
   * How completely this wine is described, 0-100 (P1-12).
   *
   * **The one field here that is not a column**, and it is sent rather than
   * left to the client for a reason that is about agreement, not effort: the
   * catalogue can *filter* by completeness band (P1-09), and that filtering
   * happens in SQL. If the client recomputed the score, a deployment where the
   * two disagreed would show a seller a wine under "Da completare" with a
   * "Buono" badge beside it. Sending it means there is one number.
   */
  completeness: z.number().int().min(0).max(100),
  createdAt: timestamp,
  updatedAt: timestamp,
});

/**
 * What a client may send when creating or editing a wine (P1-01).
 *
 * **Hand-written, and only safe because something checks it.** This package
 * depends on `zod` and nothing else on purpose — the dashboard and the widget
 * bundle it, and importing `productInsert` would pull `drizzle-orm` and the
 * whole schema into a browser. So the wire shape is written out here, which
 * departs from "refine, never redefine" (P0-42).
 *
 * `apps/api/test/product-contracts.test.ts` asserts that this and
 * `productInsert` accept the same fields and require the same ones. Without
 * that, a field the form offers and the server strips is a value a seller typed
 * and lost, with no error to explain it — and a field required here but not
 * there is a wine nobody can save for a reason that is not real.
 *
 * `tenantId`, `id` and the timestamps are absent for the reason P0-42 gives:
 * they are server-owned, and a body carrying one is either confused or probing.
 */
export const productRequest = z.object({
  sku: z.string().min(1).max(64),
  externalVariantId: z.string().nullish(),
  name: z.string().min(1).max(200),
  producer: z.string().nullish(),
  vintage: z.number().int().nullish(),
  wineType: z.string(),
  grapeVarieties: z.array(z.string()).nullish(),
  region: z.string().nullish(),
  denomination: z.string().nullish(),
  styleTags: z.array(z.string()).nullish(),
  tastingNotes: z.string().nullish(),
  foodPairings: z.array(z.string()).nullish(),
  /** `numeric` on the wire is a string, so 13.50 round-trips exactly. */
  alcoholPct: z.string().nullish(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string(),
  stockStatus: z.enum(['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER']),
  stockQty: z.number().int().nonnegative().nullish(),
  productUrl: z.string().nullish(),
  imageUrl: z.string().nullish(),
  /*
   * `status`, `embeddingState` and `contentHash` are absent, and each for a
   * concrete reason rather than tidiness — see `PRODUCT_SERVER_OWNED` in
   * `packages/db/src/contracts.ts`. The short version: archiving through a
   * field rather than the route would leave the vectors in place, so a wine
   * would be hidden from its seller and still recommended to visitors.
   */
});

export type ProductRequest = z.infer<typeof productRequest>;

/**
 * The created product, returned in full.
 *
 * Not just an id: the server fills in defaults the form never sent — `status`,
 * `embeddingState`, both timestamps — and a client that had to re-fetch to
 * learn them would show a row that disagrees with the database for one round
 * trip. **`contentHash` is deliberately absent**: it is an internal cost
 * control, and a client that could see it would eventually branch on it.
 */
export const productCreatedResponse = productSchema;

/**
 * The product after a patch (P1-03).
 *
 * The same shape, and there is no `reindexed` flag: `embeddingState` already
 * carries it. An edit that changed something the model reads leaves the row
 * `STALE` — findable under its previous description while the new one is built
 * — as against `PENDING`, which means never indexed at all. A second field
 * saying the same thing is a second thing to keep true.
 */
export const productUpdatedResponse = productSchema;

/**
 * One page of the catalogue (P1-06).
 *
 * **`nextCursor` rather than a page number or a total.** Keyset pagination has
 * no page numbers to give, and that is the point: an `OFFSET` page two repeats
 * a row when something was inserted while somebody was paging, which on an
 * import screen is exactly when the data is changing. No total either — it
 * would be a second scan of the whole catalogue on every page, for information
 * the client does not need in order to decide whether to offer "next".
 *
 * The cursor is opaque on purpose. A client that parsed it would depend on the
 * sort implementation, and adding a sort column would become a breaking change.
 */
export const productListResponse = z.object({
  items: z.array(productSchema),
  nextCursor: z.string().nullable(),
  /**
   * How the rows were matched, when a search phrase was given (P1-08).
   *
   * **`similar` means nothing matched exactly**, and saying so is the point: a
   * fallback presented as an exact match leads a seller to conclude their
   * catalogue contains something it does not — and the wrong conclusion is the
   * one the interface encouraged. `null` when there was no search at all.
   */
  matchedBy: z.enum(['exact', 'similar']).nullable(),
});

/**
 * The answer to a delete (P1-04).
 *
 * **It says what happened rather than returning 204**, and the wording is the
 * point: `noLongerRecommended` is the property a seller actually cares about,
 * and it is a different claim from "the row is gone" — the row is not gone. The
 * dashboard can say "this wine will no longer be recommended" without inferring
 * it from a status code, which is the sort of inference that goes stale the day
 * the behaviour changes.
 *
 * `vectorsRemoved` is reported because zero is meaningful: it means the wine had
 * never been indexed, which is a different thing from a delete that failed to
 * clean up.
 */
export const productArchivedResponse = z.object({
  id: z.string(),
  status: z.literal('ARCHIVED'),
  noLongerRecommended: z.literal(true),
  vectorsRemoved: z.number().int().nonnegative(),
});

/**
 * The answer to a single reindex (P1-39).
 *
 * **The product comes back, which is what makes the button honest.** A reindex
 * moves the wine's embedding state — an `INDEXED` one becomes `STALE`, a
 * `FAILED` one returns to `PENDING` with its error cleared — and P1-40's grid
 * has to show that immediately. Returning the row means the grid re-renders
 * from the server's answer rather than guessing the transition, which is the
 * difference between a column that is right and a column that agrees with
 * itself.
 */
export const productReindexedResponse = z.object({
  product: productSchema,
  /**
   * **Not a promise that anything will be re-computed**, and the name is chosen
   * to avoid making one. A wine whose vector already matches its text costs no
   * provider call by design (P1-34) — the job runs, finds nothing to do and
   * reconciles the state. What is true is that a job is queued.
   */
  queued: z.literal(true),
});

/**
 * The answer to a catalogue-wide reindex (P1-39).
 *
 * `queued` is the number of wines re-queued, which is the count of *active*
 * products — archived ones are left alone, because re-embedding one would put
 * it back in front of visitors.
 *
 * `batchId` identifies this run on every outbox row it created. It is not a
 * handle to poll: there is no job table behind it, and inventing one to give
 * this endpoint a status URL would be a design decision taken for the sake of a
 * response shape. What it buys is the ability to tell one run's rows from
 * another's when reading the queue.
 */
export const catalogueReindexedResponse = z.object({
  batchId: z.string(),
  queued: z.number().int().nonnegative(),
});

/**
 * Every dashboard response, keyed by `METHOD path`.
 *
 * The client's `request()` is typed off this, so calling an endpoint returns
 * the right shape without a cast and a typo in the path is a compile error.
 */
export const DASHBOARD_RESPONSES = {
  'GET /v1/dashboard': surfaceResponse,
  'GET /v1/dashboard/me': meResponse,
  'GET /v1/dashboard/context': contextResponse,
  'POST /v1/dashboard/members/invite': inviteResponse,
  'GET /v1/dashboard/members': rosterResponse,
  'GET /v1/dashboard/members/invitations': pendingInvitationsResponse,
  'PATCH /v1/dashboard/members/:userId': roleChangeResponse,
  'DELETE /v1/dashboard/members/:userId': memberRemovedResponse,
  'DELETE /v1/dashboard/members/invitations/:id': invitationRevokedResponse,
  'POST /v1/dashboard/members/accept': acceptInviteResponse,
  'POST /v1/dashboard/products': productCreatedResponse,
  'PATCH /v1/dashboard/products/:id': productUpdatedResponse,
  'DELETE /v1/dashboard/products/:id': productArchivedResponse,
  'GET /v1/dashboard/products': productListResponse,
  'POST /v1/dashboard/products/reindex-all': catalogueReindexedResponse,
  'POST /v1/dashboard/products/:id/reindex': productReindexedResponse,
} as const;

export type DashboardEndpoint = keyof typeof DASHBOARD_RESPONSES;
export type ResponseOf<E extends DashboardEndpoint> = z.infer<(typeof DASHBOARD_RESPONSES)[E]>;
