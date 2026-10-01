# 0030. The tenant directory is a ninth RLS scope, and nobody can hold it

Status: Accepted
Date: 2026-10-01

## Context

P5-13 rolls the usage ledger up into `usage_daily` every night, one row per tenant per day. The row
asks for a row of noughts on a day with no events, because a chart reads a missing day as "no
data" and draws a line through it. So the job must know every tenant, including the ones that did
nothing yesterday — and `tenants` is under `tenant_isolation` with `FORCE`. A job on a connection
with no tenant set reads no tenants and rolls up nothing, every night, successfully.

There is no tenant to scope the read to. Learning which tenants exist is the read across tenants.

The obvious alternatives each fail somewhere. Iterating the ledger finds only tenants that had
usage, so the quiet days the row cares about are exactly the ones missed. Updating `usage_daily`
on every billed turn, inside the turn's transaction, produces no row for a day with no turns, and
turns a recompute into an increment that a retry doubles.

## Decision

A ninth scope, beside `withTenant`, `withUser`, `withInvitation`, `withOutbox`, `withWidgetKey`,
`withLapsedRevocations`, the secret-key resolution and the domain-claim scopes. It sets a
transaction-local GUC, `app.tenant_directory`, and migration `0069` re-creates `tenant_isolation`
on `tenants` with one more branch:

```sql
USING      (… every branch P4-19b left …
            OR app.tenant_directory = 'on')
WITH CHECK (id = app.tenant_id)
```

**It is not a scope a caller can hold.** There is no `withTenantDirectory(fn)`. The flag is set
inside `listTenantDirectory`, in a `READ ONLY` transaction, for one statement that selects `id` and
`created_at`. The transaction ends before the list is returned, and the job then reaches each
tenant's rows the ordinary way, through `withTenant`. `WITH CHECK` stays tenant-only, so even a
writable transaction holding the flag could not change a tenant row; the integration suite asserts
that it cannot.

## Consequences

**The cost, stated first.** The branch admits every row of `tenants`, all columns, to whichever
transaction sets the flag. RLS is row-level: it cannot narrow the columns. Any code running as
`app_rw` that sets `app.tenant_directory` can read every winery's name, plan, Stripe ids and invoice
details. What stops that is the boundary rule naming `tenant-directory.ts` as the one module that may
open a transaction for it, and code review — the same two things that bound every other flag here.

**It widens the most-read table.** Every request that reads `tenants` now evaluates one more `OR`
against a setting that is almost always unset. The cost is a `current_setting` call per row
considered; it is noise beside the widget branch's subqueries, which run first.

**A tenant created during a run** may or may not be in that night's list. The window covers the day
before as well, so its first day is rolled up the next night at the latest.

## Alternatives rejected

**A `SECURITY DEFINER` function returning ids.** It would narrow the columns, which the policy
cannot. But `FORCE ROW LEVEL SECURITY` applies to the table's owner too, so the function would need
an owner with `BYPASSRLS` — a role that reads every table unscoped, whose only guard is that nobody
connects as it. That is a bigger hole, made smaller only by convention.

**Rolling up only tenants with usage.** It finds no row to write on exactly the days the row asks
for, and the gaps break the history charts it exists to feed.

**A second policy on `tenants`.** Permissive policies are OR-ed, so it would bypass
`tenant_isolation` rather than adjust it — `rls-coverage.integration.test.ts` refuses it for that
reason, as ADR 0021 records.
