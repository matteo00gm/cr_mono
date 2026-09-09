# 0021. The outbox poller is a fourth RLS scope, and the first one that widens

Status: Accepted
Date: 2026-09-09

## Context

Since P0-36 every product write has inserted a row into `outbox` in the same transaction, which
is what makes "a committed product has a queued embedding job" true. Nothing has ever drained
that table. Every wine created so far is `PENDING` for ever, with no error anywhere: the
guarantee held perfectly and the queue had no consumer.

The consumer has to read the queue for the whole platform. `outbox` carries `tenant_id` and, like
every other tenant table, a `tenant_isolation` policy under `ENABLE` plus `FORCE`, so a read with
no `app.tenant_id` set returns zero rows — silently. A poller written the obvious way would report
a clean pass over an empty queue, once a minute, for ever, while the backlog grew behind it.

There is no tenant to scope the poller to. Asking "which tenants have work" is the same
cross-tenant read as asking for the work, so the question is circular in the way ADR 0019's
invitation lookup was.

ADR 0019 closes by saying a fourth scope should be treated as a design change rather than a
configuration one. This is that change.

## Decision

A fourth scope, `withOutbox`, alongside `withTenant` (P0-19), `withUser` (P0-47) and
`withInvitation` (P0-51). It sets a transaction-local GUC, `app.outbox_poller`, and two new
policies on `outbox` admit rows when it is set:

- `outbox_poller_read`, `FOR SELECT`
- `outbox_poller_release`, `FOR UPDATE`

`tenant_isolation` is untouched and still applies; permissive policies are OR-ed, so an ordinary
request continues to see exactly one tenant's rows and continues to be unable to enqueue a job
naming another.

**This scope widens where the previous two narrow, and that is the material difference.**
`app.user_id` and `app.invitation_token` each admit the rows belonging to the caller: a wrong
value sees less, never more. `app.outbox_poller` is an unlock — a transaction that sets it reads
every tenant's outbox rows. Calling it "a scope" without saying that plainly would be how a hole
gets reviewed as a feature.

## Consequences

**The cost, stated first.** There is now a flag that any code running as `app_rw` can set to read
one table across every tenant. What crosses that boundary is a tenant id, a product id, the
string `embedding.requested` and a one-word reason — `enqueueEmbedding` is the only writer, and
the payload is `{ reason }`. So the leak available through this flag is the _fact_ that a seller
changed something and roughly when, never what they changed, and never anything a visitor typed.
That is a real disclosure and it is small; it is not nothing, and a future writer putting
catalogue content into an outbox payload would make it large without touching this ADR.

**What bounds it.** A policy attaches to one table, so the flag reaches `outbox` and nothing
else. The split by command is the other half: no INSERT, so no path under the flag can forge a
job pointing into another tenant's catalogue; no DELETE, so none can drop the evidence of one it
failed to publish. And the worker re-enters `withTenant(tenantId)` before it reads a product, so
nothing downstream of the claim inherits the unlock.

**The sanctioned un-scoped list does not grow.** `@catalogorosso/db/auth` remains the only path
that reaches a connection with no policy in front of it. Everything the poller touches is still
under RLS; what changed is which rows a policy admits, which is inspectable in
`packages/db/src/rls.ts` and asserted in both a unit and an integration suite.

**Reversibility got a sharp edge.** The generated down-migration for an ordinary policy disables
RLS on its table. Emitted for a policy _added_ to an already-protected table, it would take
`tenant_isolation` and `FORCE` down with it — rolling back this migration would leave `outbox`
with no isolation at all, and nothing would fail. The generator now knows the difference
(`amends`), and a test asserts the down file drops only the policies it added.

**A fifth scope is not licensed by this one.** The argument here rests on the table being a work
queue whose rows are pointers. It does not transfer to a table holding anything a seller or a
visitor wrote.

## Alternatives rejected

**A transaction per tenant per minute.** Scope the poller with `withTenant` and loop over the
tenant list. It needs no new GUC and no new policy, and it is the honest reading of the existing
rule. It was rejected on cost: at a thousand sellers it is a thousand transactions a minute to
move nothing, since almost every queue is empty almost always, and the scan of `tenants` that
drives it is itself a cross-tenant read of a more sensitive table than the one being protected.

**A `SECURITY DEFINER` function owning the claim.** Tighter than a flag — the unlock would be one
fixed statement rather than a setting the rest of the transaction inherits. It requires an owner
with `BYPASSRLS`, and the only such role is `app_admin`, which the bootstrap deliberately creates
`NOLOGIN` and without a password so that no automated process can hold it. Granting the runtime
role `EXECUTE` on a function that runs as `app_admin` would undo that on purpose.

**Dropping RLS from `outbox` entirely**, as `processed_webhooks` and `rate_limit_buckets` have
none. It would work for the poller and lose the writer's constraint: today a bug in product code
cannot enqueue a job carrying another tenant's id, because `WITH CHECK` refuses it. Trading a
write guarantee for a read convenience is the wrong direction.

**A secret instead of a flag.** `withInvitation`'s GUC is safe because the value is a secret held
by the _user_, so presenting it is the authorization. A secret here would have to live wherever
the poller can read it, which is wherever anything else running as `app_rw` can read it. It would
look like authorization and be nothing of the kind — worse than an honest flag, because it would
invite less scrutiny.

## Why the message carries a pointer and not a payload

Related, and load-bearing for everything above. The queued message names a product; the worker
re-reads the row and builds the embedding text from what it finds. Three things follow. Delivery
order stops mattering, so a standard queue suffices. A redelivery is free, which is what lets
`runOutboxPass` send before it marks `processed_at` — at-least-once with an idempotent consumer,
rather than at-most-once with a silent hole where a crash was. And nothing a seller wrote ever
sits in a queue, which is most of why the disclosure named above is as small as it is.
