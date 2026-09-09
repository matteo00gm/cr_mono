# apps/worker

SQS-triggered Lambda: embedding, catalogue sync, Stripe webhooks, usage
rollups. Mostly unbuilt — P1 fills it in.

## Invariants

- Bound concurrency with `MaximumConcurrency` on the event source mapping,
  **never with reserved concurrency**. With an SQS source, reserved concurrency
  throttles invocations rather than slowing polling: SQS keeps delivering,
  throttled messages return to the queue, each return increments the receive
  count, and past `maxReceiveCount` they land in the DLQ — a queue full of
  perfectly valid products that were never actually attempted (P1-42).
- The same database rules apply here as anywhere: `withTenant()` or nothing. A
  job that processes one tenant's work still runs under that tenant's context
  (P0-19).
- A job runs outside a request, so there is no request context and `audit()`
  will refuse. Establish one deliberately if the work is auditable (P0-53).
- The **outbox poller is the one exception to the `withTenant()` rule**, and
  only for the claim itself: `withOutbox()` sets a GUC that reads `outbox` across every
  tenant, because draining one queue for the whole platform has no tenant to be
  scoped to (P1-31, ADR 0021). It unlocks that one table, for SELECT and UPDATE
  only. Everything the worker does _with_ a claimed job runs under
  `withTenant(tenantId)` in the ordinary way — and the tenant comes from the row
  Postgres returned, never from the message body.
- A queued message names a product; it never describes one. The worker re-reads
  the row and builds the embedding text from what it finds, which is what makes
  a redelivery harmless and delivery order irrelevant. Putting the wine's text
  in the message would quietly break both.

## Source of truth

`EmbeddingMessage` in `src/outbox-poller.ts` is the embedding queue's shape. The
remaining queues define theirs as P1 fills them in.
