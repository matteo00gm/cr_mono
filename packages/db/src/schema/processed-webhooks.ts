import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `processed_webhooks` — the idempotency ledger for inbound webhooks (P0-33).
 *
 * Stripe retries, and it retries on its own schedule after a timeout it decided
 * on. Without this table a retried `customer.subscription.deleted` applies
 * twice (§3.8) — the second application acting on a state the first already
 * changed.
 *
 * **Not tenant-scoped, deliberately.** The tenant is derived *from* the event,
 * by looking up the Stripe customer id it carries, so at the moment this row is
 * written the tenant may not have been resolved yet — and for an event naming a
 * customer that matches nothing, never will be. There is therefore no RLS
 * policy for this table, which makes it the first table P0-41's reflection test
 * must explicitly allowlist: that test fails when a table has no policy, and
 * here the absence is correct rather than forgotten.
 */
export const processedWebhooks = pgTable(
  'processed_webhooks',
  {
    /** `stripe` today; `shopify` arrives with P6-07. */
    provider: text('provider').notNull(),

    /** The provider's own event id — `evt_...` for Stripe. */
    eventId: text('event_id').notNull(),

    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * The composite key *is* the idempotency mechanism. A second insert of the
     * same event raises a unique violation, and the handler treats that as
     * "already done" rather than as an error — which is why this is a primary
     * key and not a unique index over a surrogate id: there is nothing else
     * about a row here worth identifying.
     *
     * `provider` leads because event ids are only unique within a provider.
     */
    primaryKey({ columns: [table.provider, table.eventId] }),
  ],
);
