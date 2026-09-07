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
  createdAt: timestamp,
  updatedAt: timestamp,
});

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
} as const;

export type DashboardEndpoint = keyof typeof DASHBOARD_RESPONSES;
export type ResponseOf<E extends DashboardEndpoint> = z.infer<(typeof DASHBOARD_RESPONSES)[E]>;
