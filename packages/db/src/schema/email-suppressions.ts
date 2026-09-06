import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `email_suppressions` — addresses we must stop sending to (P0-64).
 *
 * A hard bounce is not a delivery failure to retry, it is a statement that the
 * mailbox does not exist. Sending to it again is what moves a sending domain
 * from "good reputation" to "filtered", and reputation is the slow failure:
 * slow to notice, slow to repair, and it degrades *account recovery* mail
 * first — the messages a locked-out paying customer needs (§P0-45).
 *
 * **Not tenant-scoped, and that is the point.** The reputation being protected
 * belongs to our sending domain, not to a tenant, so a bounce recorded while
 * one winery invited `bob@example.invalid` must also stop a second winery
 * mailing the same dead address next week. A `tenant_id` here would scope away
 * exactly the protection the table exists for.
 *
 * It therefore carries no RLS policy, for the same reason `processed_webhooks`
 * carries none: no `tenant_id` column means P0-41's reflection test never
 * discovers it and has nothing to demand. That is a real decision rather than
 * an omission — see the note in `src/rls.ts`.
 *
 * Rows are written by the provider's bounce webhook and read on every send.
 */
export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    /**
     * The address, already normalised — lowercased and trimmed.
     *
     * The primary key, because an address is the only thing about a row here
     * worth identifying, and the key doubles as the idempotency mechanism: a
     * provider that delivers the same bounce twice raises a unique violation
     * the writer treats as "already known".
     *
     * Normalisation happens in the application (`normaliseAddress`) rather than
     * in a `lower()` expression index, so that the value a human reads out of
     * this table is the value the lookup uses. A stored `Bob@Example.com` that
     * only matches through an index is a row that looks suppressed and, to
     * anyone querying by hand, is not.
     */
    address: text('address').primaryKey(),

    /**
     * Why, as free text rather than an enum (P0-31 reasoning).
     *
     * `hard_bounce` and `complaint` today. A provider that invents a third
     * category next month must not need a migration before we can record it —
     * a schema change on the write path is the friction that makes people
     * record nothing.
     */
    reason: text('reason').notNull(),

    /** The provider's own explanation, kept verbatim for the human debugging it. */
    detail: text('detail'),

    suppressedAt: timestamp('suppressed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * For the operational question this table gets asked: "is the bounce rate
     * rising?" — which is a count over a recent window, not a lookup by
     * address. The primary key already serves the send path.
     */
    index('email_suppressions_suppressed_at_idx').on(table.suppressedAt),
  ],
);
