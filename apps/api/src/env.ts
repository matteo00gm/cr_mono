import type { Role } from '@catalogorosso/core';

/**
 * The Hono context variables every handler can read (P0-45).
 *
 * Kept in its own module so both surfaces and every middleware share one
 * definition. The alternative — a `declare module 'hono'` augmentation — makes
 * these variables *global*, so the widget surface would type-check a
 * `c.get('userId')` that is always undefined there. An explicit `Hono<AppEnv>`
 * keeps the shape visible at each mount point.
 *
 * The values arrive in a fixed order, and it is the order that matters:
 *
 * 1. `userId` — P0-45, from the session cookie, and **nothing else**.
 * 2. `tenantId` and `role` — P0-47, read together from one `memberships` row.
 *
 * They stay separate because they are established by different evidence. A
 * user is who the cookie says; a tenant is what the database says about that
 * user, and never what the request says (§3.5).
 */
export interface AppEnv {
  Variables: {
    /** Set by `requireUser`. Absent on the widget surface, always. */
    userId: string;

    /**
     * Set by `resolveTenant`, from a `memberships` row — never from the
     * request. Every database call scopes on this and nothing else.
     */
    tenantId: string;

    /**
     * From the **same** membership row as `tenantId`, and that pairing is the
     * point. A role read separately, or cached per user, grants somebody who is
     * EDITOR on one winery and OWNER on another the higher role on both.
     */
    role: Role;
  };
}
