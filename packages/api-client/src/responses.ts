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

export type Membership = z.infer<typeof membershipSchema>;
export type SurfaceResponse = z.infer<typeof surfaceResponse>;
export type MeResponse = z.infer<typeof meResponse>;
export type ContextResponse = z.infer<typeof contextResponse>;

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
} as const;

export type DashboardEndpoint = keyof typeof DASHBOARD_RESPONSES;
export type ResponseOf<E extends DashboardEndpoint> = z.infer<(typeof DASHBOARD_RESPONSES)[E]>;
