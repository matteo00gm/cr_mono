# 0024. The plan cap is counted twice, on purpose

Status: Accepted
Date: 2026-09-22

Rows: P2-04, P2-29, P2-31, P2-36

## Context

A plan sells a number of messages a month. Two things count them, and they were
built for different reasons three rows apart.

**The rate-limit bucket** (P2-04). `widgetLimitChecks` pushes `planCapCheck` for
the `chat` endpoint, so every chat request spends a monthly bucket in
`rate_limit_buckets` on the same round trip as the per-minute checks. It is an
`INSERT … ON CONFLICT DO UPDATE … RETURNING`, so it is **atomic**: two requests
arriving together at the cap cannot both pass.

**The usage ledger** (P2-31). `usage_events` gets one row per turn that was
actually billed, written after the stream in the same transaction as the turn
itself. It is what a seller's invoice is built from, what §2.3's banner reports,
and what P2-36's gate reads before retrieval and before any model call.

They do not agree. A chat request refused **after** the limiter and **before**
the model — a malformed body, an aborted connection, a provider that never
answered — spends a bucket message that is never billed. So the bucket runs
ahead of the ledger by the error rate.

The failure that makes this worth writing down: a seller reads "20 left" on a
banner built from the ledger and is refused by a bucket that disagrees. That is
exactly the shape `planCapCheck`'s own comment warns about — "a widget told `ok`
by one and refused by the other" — reached through a different pair.

## Decision

**Both stay, and the stricter one wins.**

The ledger is authoritative for what a tenant is _billed_, and P2-36's gate
reads it before anything is spent. The bucket stays as the atomic pre-check,
because atomicity is the one property the ledger check cannot have: it is
read-then-act, so N concurrent requests at the cap can all pass it.

The consequence is accepted rather than hidden: the platform **over-refuses** by
the number of chat requests that failed after the limiter. That is the safe
direction — a tenant is never served past their cap — and it is bounded by the
error rate, which is small and observable.

## Consequences

- A tenant may be refused slightly before their cap. Nobody is served past it.
- The divergence is the chat error rate. If that rate ever stops being small,
  this decision is the thing to revisit, and a new ADR supersedes this one.
- `planCapCheck` has two callers and must stay one definition: the limiter
  spends the key it builds, the config route reads the month with the same key,
  and `tenantOfPlanCap` reads the tenant back out of it (P2-36).
- The open item in `plan-v1.md` that recorded this as unresolved points here.

## Alternatives rejected

**Drop `planCapCheck` from `widgetLimitChecks` and let the ledger decide alone.**
Tried, and reverted. It is the clean answer on paper and it gives up atomicity:
at the cap, every concurrent request reads the same count and every one of them
passes. At this product's scale that is a handful of free messages; at a scale
where it matters, it is the shape of an unbounded bill. It also rewrites nine
tests' worth of P2-04's tested design inside an unrelated row, which is how a
cost control gets changed by somebody who was doing something else.

**Drop the ledger check and let the bucket decide alone.** Cheaper on the hot
path, and wrong in the direction that matters: the bucket counts attempts, the
plan sells messages, and a tenant would lose allowance to their own failed
requests with nothing to point at.

**Reconcile the bucket from the ledger.** Correct and atomic, and it needs a job
that rewrites a counter the limiter owns — a second writer to a table whose
whole design is one atomic statement per caller. Not worth it for a divergence
measured in failed requests.
