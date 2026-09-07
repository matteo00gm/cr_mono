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

## Source of truth

The queue's message shapes, once P1 defines them.
