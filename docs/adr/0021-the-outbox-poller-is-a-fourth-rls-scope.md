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
`withInvitation` (P0-51). It sets a transaction-local GUC, `app.outbox_poller`, and migration
`0036` replaces `tenant_isolation` on `outbox` with one that admits it:

```sql
USING      (tenant_id = app.tenant_id OR app.outbox_poller = 'on')
WITH CHECK (tenant_id = app.tenant_id)
```

**One policy, not two**, and the branch is in `USING` only. Both halves of that are the decision.

**This scope widens where the previous two narrow, and that is the material difference.**
`app.user_id` and `app.invitation_token` each admit the rows belonging to the caller: a wrong
value sees less, never more. `app.outbox_poller` admits every tenant's rows. Calling it "a scope"
without saying that plainly would be how a hole gets reviewed as a feature.

**What keeps it to a read.** `WITH CHECK` stays tenant-only, exactly as `memberships` does with
`app.user_id`. So a transaction holding the flag and nothing else can see the queue and cannot
write to it: an INSERT names a tenant it cannot satisfy, and an UPDATE fails the same check. The
poller's own releases work because `runOutboxPass` sets `app.tenant_id` **from the row it
claimed** before it writes — `withInvitation`'s shape, read under one context and then narrow to
the tenant Postgres itself produced.

**DELETE is the exception, and it is closed at the grant.** A DELETE is filtered by `USING`
alone; there is no new row, so there is nothing for `WITH CHECK` to refuse. Under the flag,
`delete from outbox` would match every tenant's rows. Migration `0037` revokes DELETE on `outbox`
from `app_rw` — the P0-31 mechanism, applied to a queue instead of a ledger.

## Consequences

**The cost, stated first.** There is now a flag that any code running as `app_rw` can set to read
one table across every tenant. What crosses that boundary is a tenant id, a product id, the
string `embedding.requested` and a one-word reason — `enqueueEmbedding` is the only writer, and
the payload is `{ reason }`. So the disclosure available through this flag is the _fact_ that a
seller changed something and roughly when, never what they changed, and never anything a visitor
typed. That is real and it is small; it is not nothing, and a future writer putting catalogue
content into an outbox payload would make it large without touching this ADR.

**The sanctioned un-scoped list does not grow.** `@catalogorosso/db/auth` remains the only path
that reaches a connection with no policy in front of it. Everything the poller touches is still
under RLS; what changed is which rows one policy admits, which is inspectable in
`packages/db/src/rls.ts` and asserted in both a unit and an integration suite.

**Nothing may delete an outbox row any more**, including the ordinary tenant path. Nothing did,
so nothing breaks — but retention pruning, when it is wanted, now belongs to a role that is not
`app_rw`, the way tenant deletion already does (P0-33a).

**Reversibility got a sharp edge, twice.** A migration that _replaces_ a policy must reverse to
the definition it replaced. Dropping the new one and stopping leaves the table with no policy
while RLS stays forced — every query returns nothing. Emitting the generator's usual
`DISABLE ROW LEVEL SECURITY` instead leaves the table with no isolation at all, and nothing
fails. `RlsPolicy` gained `supersedes`, the down file re-creates the previous entry's definition,
and a test asserts both.

**An entry in `RLS_POLICIES` is no longer one table.** Two integration assertions counted
definitions and meant tables; they now de-duplicate. That is a correction, not a weakening.

**A fifth scope is not licensed by this one.** The argument here rests on the table being a work
queue whose rows are pointers. It does not transfer to a table holding anything a seller or a
visitor wrote.

## Alternatives rejected

**A second, narrower policy** — `FOR SELECT` and `FOR UPDATE` gated on the flag, leaving
`tenant_isolation` untouched. This was the first implementation, and it is wrong for a reason
this repository had already written down and asserted against a live database:
`rls-coverage.integration.test.ts` says _"a second one added for a plausible reason does not
modify `tenant_isolation`, it bypasses it — and every existing isolation test still passes,
because they only ever assert what one tenant can see."_ CI failed on that test, which is the
guard working exactly as intended. The command split it bought is recovered by the `WITH CHECK`
asymmetry plus the DELETE revoke, and that combination is tighter: it constrains every path in
the application rather than only the one holding the flag.

**A transaction per tenant per minute.** Scope the poller with `withTenant` and loop over the
tenant list. It needs no new GUC and no new policy, and it is the honest reading of the existing
rule. Rejected on cost: at a thousand sellers it is a thousand transactions a minute to move
nothing, since almost every queue is empty almost always, and the scan of `tenants` that drives
it is itself a cross-tenant read of a more sensitive table than the one being protected.

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
