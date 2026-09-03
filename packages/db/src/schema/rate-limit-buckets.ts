import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `rate_limit_buckets` — storage for the Postgres token-bucket limiter (P0-34).
 *
 * Rate limiting is a security control, and at the ~10-tenant ceiling (§5.0)
 * Postgres is its permanent home rather than a stepping stone to Redis.
 *
 * **No `tenant_id` column, deliberately.** The tenant is encoded inside
 * `bucket_key` along with the dimension it limits — `tenant:<id>:min`,
 * `session:<id>`, `ip:<hash>:<tenant>` — because the limiter also has to count
 * things that belong to no tenant, such as an IP hammering an invalid key. It
 * is therefore not RLS-protected, and P0-41's reflection test will not see it:
 * that test looks for tables *having* a `tenant_id`, so this one is out of
 * scope rather than allowlisted. Isolation here is the key format's job.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    /** Dimension and subject in one string — see the module comment. */
    bucketKey: text('bucket_key').notNull(),

    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),

    count: integer('count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * `(bucket_key, window_start)` is what makes the whole limiter check a
     * single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (P2-02): one
     * round trip, no read-then-write race between checking a count and
     * incrementing it.
     */
    primaryKey({ columns: [table.bucketKey, table.windowStart] }),

    /**
     * For the prune job (P2-14), which deletes windows that have closed. It
     * scans by time, not by key, so the primary key does not serve it.
     */
    index('rate_limit_buckets_window_start_idx').on(table.windowStart),
  ],
);
