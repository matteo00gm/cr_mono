/**
 * The capability table (P0-49).
 *
 * **Scattered `if (role === 'OWNER')` checks cannot be audited or tested
 * exhaustively.** A single table can be — and it is what makes P0-50's
 * generated role×endpoint matrix possible at all, because a matrix needs
 * something to compare the router against.
 *
 * `Role` lives here rather than in `packages/core`, which is where it started.
 * The reason is a cycle waiting to happen: P0-53's `audit()` is in `core` and
 * must scrub through `security`'s redaction, so `core → security` is an edge
 * that has to exist. Had the capability table imported `Role` from `core`, the
 * two packages would point at each other and the P0-09 `no-circular` rule would
 * refuse both. Authorization vocabulary belongs on the security side anyway.
 */

/**
 * Two roles, and deliberately no third.
 *
 * There is no `VIEWER`: every distinction the product needs is expressible as
 * OWNER-versus-EDITOR, and a role nobody can articulate the purpose of is a
 * role that accumulates permissions by accident.
 */
export const ROLES = ['OWNER', 'EDITOR'] as const;

export type Role = (typeof ROLES)[number];

/**
 * What each role may do.
 *
 * The split is one question: **does this action change what the tenant is or
 * what it costs?** Billing, members, domains, keys and the widget's public
 * configuration all do — they alter the account itself, or who can reach it —
 * so they are OWNER-only. The catalogue and its analytics are the day-to-day
 * work an EDITOR was invited to do.
 *
 * `satisfies` rather than a type annotation, so the keys stay literal and
 * `Capability` is the exact union rather than `string`. That is what makes a
 * typo in a route declaration a compile error instead of a runtime 403.
 */
export const CAPABILITIES = {
  /** Payment method, plan, invoices. Changes what the tenant costs. */
  'billing:manage': ['OWNER'],
  /** Invites, removals, role changes. Changes who can reach the account. */
  'members:manage': ['OWNER'],
  /** The origins the widget may be embedded on (§3.4). */
  'domains:manage': ['OWNER'],
  /** Issuing and revoking `pk_`/`sk_` keys. */
  'keys:manage': ['OWNER'],
  /** The widget's public appearance and behaviour on customers' sites. */
  'widget:configure': ['OWNER'],

  'catalog:write': ['OWNER', 'EDITOR'],
  'catalog:read': ['OWNER', 'EDITOR'],
  'analytics:read': ['OWNER', 'EDITOR'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as readonly Capability[];

/**
 * A pure function, and the only place a role is ever compared to anything.
 *
 * No context, no request, no database — so P0-50 can enumerate the whole truth
 * table in milliseconds, and so this file has nothing to mock.
 */
export const can = (role: Role, capability: Capability): boolean =>
  (CAPABILITIES[capability] as readonly Role[]).includes(role);

/**
 * Why a route may be reached without a capability.
 *
 * Not a boolean and not an absence: an explicit sentence, stored beside the
 * route. **A route with no declared access must fail closed** (P0-49), so the
 * only way to have a public route is to say out loud why — which is a thing a
 * reviewer can disagree with, unlike a missing entry nobody noticed.
 */
export interface PublicAccess {
  readonly kind: 'public';
  readonly reason: string;
}

export interface CapabilityAccess {
  readonly kind: 'capability';
  readonly capability: Capability;
}

export type RouteAccess = PublicAccess | CapabilityAccess;

export const publicRoute = (reason: string): PublicAccess => ({ kind: 'public', reason });

export const requires = (capability: Capability): CapabilityAccess => ({
  kind: 'capability',
  capability,
});
