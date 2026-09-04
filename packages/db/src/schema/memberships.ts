import { index, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { authUsers } from './auth.js';
import { tenants } from './tenants.js';

/**
 * `memberships` — which user belongs to which tenant, and as what (P0-23).
 *
 * This is where tenant resolution reads from (P0-47): the tenant a request acts
 * on is derived from this table, never from anything the client sends. That
 * makes it the table authorisation rests on, and the reason two details below
 * are worth more attention than a join table usually deserves.
 */

/**
 * `OWNER` and `EDITOR` only, per §2.7. `ADMIN` and `VIEWER` arrive later via
 * `ALTER TYPE ... ADD VALUE`, which is cheap — that is why an enum is right here
 * despite the set being expected to grow.
 */
export const membershipRole = pgEnum('membership_role', ['OWNER', 'EDITOR']);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * `text`, not `uuid`.
     *
     * Better Auth generates its own ids and they are not UUIDs (§P0-23a). A
     * `uuid` column here would reject every real user id, and converting later
     * is a migration across the one table authorisation depends on.
     *
     * The foreign key to `auth_user` lands in P0-23a, which creates that table.
     * Adding it then is a two-line ALTER against an empty table; pulling P0-23a
     * forward instead would mean settling Better Auth's id strategy, cookie
     * cache and table prefix before P0-45 provides the context for those calls.
     */
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),

    role: membershipRole('role').notNull(),

    /** Null for the first OWNER, who is not invited by anyone. */
    invitedBy: text('invited_by'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /** One membership per user per tenant; the role is a column, not a second row. */
    unique('memberships_tenant_user_unique').on(table.tenantId, table.userId),

    /**
     * On `user_id` alone, not on the composite.
     *
     * The hot lookup is "which tenants does this user belong to", which runs on
     * every authenticated request before a tenant is known. The unique
     * constraint above already indexes `(tenant_id, user_id)`, and a B-tree on
     * that pair cannot serve a query with no `tenant_id` predicate.
     */
    index('memberships_user_id_idx').on(table.userId),
  ],
);
