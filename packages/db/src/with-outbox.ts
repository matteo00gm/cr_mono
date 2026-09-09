import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * The outbox poller's scope (P1-31).
 *
 * **The fourth RLS context, and the first one that widens rather than narrows.**
 * That sentence is the whole of the review this needs, so it goes first.
 *
 * `withUser` (P0-47) and `withInvitation` (P0-51) each admit the rows belonging
 * to the caller: a wrong user id sees less, a wrong token sees nothing. This
 * one admits every tenant's rows at once. It is an unlock, and calling it
 * "a scope" without saying so would be the kind of comment that gets a hole
 * reviewed as a feature.
 *
 * **Why there is no alternative.** The poller's job is to drain the queue for
 * the whole platform: one pass, oldest first, a hundred rows. Scoping it to a
 * tenant needs a tenant, and the only way to learn which tenants have work is
 * to read the queue — the read that needs the scope. The way out is a
 * transaction per tenant per minute, forever, over queues that are almost
 * always empty; at a thousand sellers that is a thousand transactions a minute
 * to move nothing.
 *
 * **What bounds it.** A policy attaches to one table, so this reaches `outbox`
 * and no other. What an outbox row holds is a tenant id, a product id, the
 * string `embedding.requested` and a one-word reason — `enqueueEmbedding` in
 * `products.ts` is the only writer — so what crosses the tenant boundary is
 * that *something changed*, never what. The worker then re-enters `withTenant`
 * before it reads the product itself, so nothing downstream of the claim
 * inherits the unlock. And the policy is split by command: SELECT and UPDATE,
 * never INSERT or DELETE, so this path can move a job through the queue and
 * cannot forge one or lose one.
 *
 * **Why a flag and not a secret.** `withInvitation`'s token works because the
 * value is held by the *user* — presenting it is the authorization. A secret
 * here would have to live where the poller can read it, which is where anything
 * else running as `app_rw` can read it too. It would look like authorization
 * and be nothing of the kind, which is worse than an honest flag.
 *
 * The value is transaction-local (`set_config`'s third argument), like every
 * other context here. Without it the setting outlives the transaction on a
 * pooled connection, and the next request — an ordinary tenant request — would
 * run with the outbox unlocked.
 */
export const OUTBOX_POLLER_GUC = 'app.outbox_poller';

/**
 * Runs `fn` in a transaction that can see the whole outbox.
 *
 * Named for what it unlocks rather than for the poller, because the next thing
 * that reaches for it will not be called a poller either — and a caller writing
 * `withOutbox` has to notice it is asking for the outbox, not for a database.
 */
export const withOutbox = async <T>(
  fn: (tx: DbTransaction) => Promise<T>,
  db: Database = getDb(),
): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config(${OUTBOX_POLLER_GUC}, 'on', true)`);

    return fn(tx);
  });
