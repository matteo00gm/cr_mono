import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `tenant_domains` — the verified origins a widget may be served to (P0-24).
 *
 * The unique constraint on `origin` is the anti-widget-sharing backbone (§3.2):
 * it makes "an origin belongs to exactly one tenant" a database guarantee rather
 * than something the application remembers to check. Everything else in this
 * table exists to get an origin honestly into that constraint.
 */

export const domainStatus = pgEnum('domain_status', ['PENDING', 'VERIFIED']);

/** The two proofs of control from §3.3. Null until the seller picks one. */
export const domainVerificationMethod = pgEnum('domain_verification_method', [
  'DNS_TXT',
  'WELL_KNOWN',
]);

/**
 * Lowercase scheme + host + optional port. No path, no trailing slash, no
 * trailing dot, no empty label, no hyphen at a label edge.
 *
 * Defence in depth, not the primary control: P2-05 normalises an origin before
 * it ever reaches here. This is what holds if that normalisation is bypassed,
 * refactored, or simply not reached by some future code path — and the values it
 * rejects are exactly the bypass shapes §6.3 enumerates. `https://winery.com.`
 * and `HTTPS://WINERY.COM` are the interesting ones: both are the same origin to
 * a browser and a different string to a naive allowlist comparison, which is the
 * whole attack.
 */
const ORIGIN_FORMAT =
  "origin ~ '^https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$'";

export const tenantDomains = pgTable(
  'tenant_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * The serialized origin — `https://www.winery.com` — never a bare hostname.
     *
     * Scheme and port have to be part of the stored value, because they are part
     * of what a browser sends in `Origin` and part of what makes two things the
     * same origin. Storing a hostname would make `http://` and `https://`
     * indistinguishable in the allowlist.
     *
     * Unique **globally**, not per tenant. This is the constraint the whole
     * anti-sharing design rests on, and it deliberately covers PENDING rows as
     * well as VERIFIED ones: scoping it to verified rows would let two tenants
     * hold competing claims and race at verification time, which moves the
     * conflict from "this insert fails immediately" to "someone loses a domain
     * they have already built a widget against".
     *
     * The cost is that an abandoned claim holds an origin. That is what
     * `verification_expires_at` is for, and the contested-owner path is P4-18's
     * `domain_claims`. Note for the API layer: a 23505 on this constraint must
     * surface as a flat refusal, never as "that origin belongs to another
     * tenant" — otherwise it is an oracle for enumerating who the customers are.
     */
    origin: text('origin').notNull().unique(),

    /**
     * The verified eTLD+1 (§3.3). Proving control of `winery.com` is what lets a
     * seller register `https://shop.winery.com` without a second round of DNS.
     */
    registrableDomain: text('registrable_domain').notNull(),

    status: domainStatus('status').notNull().default('PENDING'),

    verificationMethod: domainVerificationMethod('verification_method'),
    verificationToken: text('verification_token'),
    verificationExpiresAt: timestamp('verification_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check('tenant_domains_origin_format', sql.raw(ORIGIN_FORMAT)),

    /**
     * The unique index on `origin` serves origin → tenant, the widget's hot
     * path. Nothing indexes `tenant_id`, so "list this tenant's domains" and,
     * more importantly, the referential check behind `DELETE FROM tenants` would
     * both scan the table.
     */
    index('tenant_domains_tenant_id_idx').on(table.tenantId),
  ],
);
