import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

import { conversations } from './schema/conversations.js';
import { memberships } from './schema/memberships.js';
import { products } from './schema/products.js';
import { tenantDomains } from './schema/tenant-domains.js';
import { tenants } from './schema/tenants.js';
import { widgetEvents } from './schema/widget-events.js';

/**
 * Request and response contracts, derived from the tables (P0-42).
 *
 * One definition, three consumers — widget, dashboard, API — and no drift,
 * because the shapes are generated from the same `pgTable` declarations the
 * migrations are. A hand-written contracts package is a second source of truth
 * that agrees with the first exactly until someone changes one of them.
 *
 * **Refine, never redefine.** Every schema here starts from `createInsertSchema`
 * or `createSelectSchema` and narrows. Retyping a column by hand reintroduces
 * the drift this exists to remove, and does it invisibly: the hand-written type
 * stays valid TypeScript long after the column changes underneath it.
 */

/**
 * Columns no client may ever supply, stripped from every insert contract.
 *
 * `tenant_id` is the load-bearing one, and its omission is a **type-level**
 * guarantee rather than a runtime check: with the field absent from the schema,
 * code that tries to read a tenant from a request body does not compile. That
 * reinforces P0-48's lint rule from the other side — the rule catches the
 * pattern, this makes the pattern unrepresentable.
 *
 * The rest are server-owned: an id the database generates, timestamps a trigger
 * maintains. A client that sends them is either confused or probing.
 */
const SERVER_OWNED = {
  id: true,
  tenantId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Two tables do not have all four, and `omit` is typed against the columns that
 * exist — so spreading the constant at them is a compile error rather than a
 * silent no-op. That is the right behaviour and worth keeping: the exceptions
 * are stated here instead of being hidden by a looser type.
 *
 * `tenants` has no `tenant_id` because it *is* the tenant, and `widget_events`
 * has no `updated_at` because an event is never updated.
 */
const TENANT_SERVER_OWNED = { id: true, createdAt: true, updatedAt: true } as const;
const EVENT_SERVER_OWNED = { id: true, tenantId: true, createdAt: true } as const;

/**
 * Zod strips unknown keys by default, and that default is what makes the
 * omissions above meaningful: a payload carrying `tenantId` parses cleanly with
 * the field discarded rather than failing. Asserted in the tests, because
 * `.passthrough()` anywhere in a chain would silently reverse it and every
 * existing test would still pass.
 */
export const productInsert = createInsertSchema(products, {
  sku: (schema) => schema.min(1).max(64),
  name: (schema) => schema.min(1).max(200),
  priceCents: (schema) => schema.int().nonnegative(),
  stockQty: (schema) => schema.int().nonnegative(),
}).omit(SERVER_OWNED);

export const productSelect = createSelectSchema(products);

export const productUpdate = productInsert.partial();

/**
 * `slug` is given a schema outright rather than refined, and that is not a
 * stylistic exception to "refine, never redefine".
 *
 * `slug` is `citext`, a `customType`, and drizzle-zod cannot infer anything
 * about a custom type — it produces `z.any()`. Refining is therefore impossible
 * (`schema.min` does not exist on `ZodAny`) and, worse, leaving it derived
 * yields a contract that accepts a number for a slug while looking correct.
 *
 * This applies to every `customType` in the schema, so `contracts.test.ts`
 * asserts no field in any contract is `ZodAny` — the guard that catches the
 * next one rather than this one.
 */
export const tenantInsert = createInsertSchema(tenants, {
  name: (schema) => schema.min(1).max(120),
  slug: z.string().min(1).max(64),
}).omit(TENANT_SERVER_OWNED);

/**
 * The same `citext` problem on the read side, and it needs the same explicit
 * schema: a select contract whose `slug` is `z.any()` types every consumer's
 * slug as `any`, which propagates silently into the widget and the dashboard.
 */
export const tenantSelect = createSelectSchema(tenants, {
  slug: z.string(),
});

/**
 * `origin` is validated as a string here, not a URL.
 *
 * The real check is P2-05's normalisation function, which has to agree with the
 * `tenant_domains_origin_format` CHECK in the database — scheme and host
 * lowercased, no path, no trailing slash. Zod's `.url()` accepts every one of
 * the forms that CHECK rejects, so using it here would produce a contract that
 * passes and an insert that fails.
 */
export const tenantDomainInsert = createInsertSchema(tenantDomains, {
  origin: (schema) => schema.min(1).max(253),
}).omit({ ...SERVER_OWNED, verifiedAt: true, verificationToken: true, status: true });

export const membershipInsert = createInsertSchema(memberships, {
  userId: (schema) => schema.min(1),
}).omit(SERVER_OWNED);

export const conversationSelect = createSelectSchema(conversations);

export const widgetEventInsert = createInsertSchema(widgetEvents).omit({
  ...EVENT_SERVER_OWNED,
  conversationId: true,
});

/**
 * The shapes with no table behind them, hand-written because there is nothing
 * to derive them from.
 *
 * Kept to the minimum for the same reason the derived ones are preferred: each
 * is a definition that can drift from the code that produces it, and only the
 * chat request and the pairing response genuinely have no table.
 */
export const chatRequest = z.object({
  message: z.string().min(1).max(2_000),
  conversationId: z.uuid().optional(),
  locale: z.enum(['it', 'en']).default('it'),
});

/**
 * What the model is allowed to return.
 *
 * `productId` is a uuid rather than free text on purpose: P2-25 allowlists the
 * recommendations against the retrieved candidates, and a schema that permitted
 * an arbitrary string would let a hallucinated product reach that check as a
 * plausible-looking value instead of failing to parse.
 */
export const pairingResponse = z.object({
  reply: z.string().min(1),
  recommendations: z
    .array(
      z.object({
        productId: z.uuid(),
        reason: z.string().min(1).max(500),
      }),
    )
    .max(8),
});

export type ProductInsert = z.infer<typeof productInsert>;
export type ProductSelect = z.infer<typeof productSelect>;
export type ProductUpdate = z.infer<typeof productUpdate>;
export type TenantInsert = z.infer<typeof tenantInsert>;
export type TenantSelect = z.infer<typeof tenantSelect>;
export type TenantDomainInsert = z.infer<typeof tenantDomainInsert>;
export type MembershipInsert = z.infer<typeof membershipInsert>;
export type ConversationSelect = z.infer<typeof conversationSelect>;
export type WidgetEventInsert = z.infer<typeof widgetEventInsert>;
export type ChatRequest = z.infer<typeof chatRequest>;
export type PairingResponse = z.infer<typeof pairingResponse>;
