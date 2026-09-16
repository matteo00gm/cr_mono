# 0023. The revocation sweep is a sixth RLS scope, and it reaches only what has lapsed

Status: Accepted
Date: 2026-09-15

## Context

`token_revocations` (P0-35) lists the widget tokens that must be refused before they expire. Every
row stops meaning anything once its token can no longer be presented, and P2-14 exists to delete
those rows before the table grows without bound.

The table carries `tenant_id` and the boilerplate `tenant_isolation` policy under `ENABLE` plus
`FORCE`. A sweep written the obvious way, `DELETE ... WHERE expires_at < now()` on a connection
with no tenant set, deletes nothing and reports success. That is the silent failure ADR 0021
described for the outbox, one table over: the sweep would run every fifteen minutes, for ever,
while the table it exists to shrink grew behind it.

Two facts make the rows' end later than their `expires_at`. P2-12a lets a session continue on a
token for thirty minutes after it expires, and asks `token_revocations` whether that token was
revoked. A revocation deleted at `expires_at` would let a revoked token continue its session for
what is left of that window. So a revocation matters until its expiry plus the continuation window.

There is no tenant to scope the sweep to. Asking which tenants have lapsed revocations is the same
cross-tenant read as finding them.

## Decision

A sixth scope, `withLapsedRevocations`, beside `withTenant`, `withUser`, `withInvitation`,
`withOutbox` and `withWidgetKey`. It sets a transaction-local GUC, `app.revocation_sweeper`, and
migration `0043` replaces `tenant_isolation` on `token_revocations` with:

```sql
USING      (tenant_id = app.tenant_id
            OR (app.revocation_sweeper = 'on'
                AND expires_at < now() - make_interval(secs => 1800)))
WITH CHECK (tenant_id = app.tenant_id)
```

**The flag never admits a row by itself.** Its branch carries the lapse predicate, taken from
`REVOCATION_SWEEP_GRACE_SEC`. So a transaction holding the flag can see, and delete, only
revocations whose token lapsed more than the continuation window ago. A revocation that could
still refuse a continuing session is invisible to it, whatever statement runs inside it.

`WITH CHECK` stays tenant-only, so the flag cannot insert a revocation or update one. An update
that tried to move a lapsed row back inside the window fails the check.

## Consequences

**The cost, stated first.** Any code running as `app_rw` can set the flag. It can then read the
lapsed revocations of every tenant: a token id, a tenant id and two timestamps. It can also delete
them, which is the point. What crosses the tenant boundary is that some tenant once revoked a token
that has since expired. That is smaller than what ADR 0021's flag discloses, and it is not nothing.

**Unlike the poller's flag, this one needs no grant change.** ADR 0021 had to revoke DELETE on
`outbox` because its flag admitted every row to a DELETE. Here the flag admits only rows that are
safe to delete, so `app_rw` keeps DELETE on `token_revocations`. The ordinary tenant path, which
P4-06 will use to revoke and un-revoke, is unchanged.

**The grace lives in two packages and a test holds them together.** The policy reads
`REVOCATION_SWEEP_GRACE_SEC` in `packages/db`. The continuation window is
`WIDGET_SESSION_CONTINUATION_SEC` in `apps/api`, which a package cannot import. A test in
`apps/api` asserts the grace is at least the window. Lengthening the window without the grace fails
there. Doing it in the migration alone means a new migration, because the value is written into the
policy as a literal.

**The sanctioned un-scoped list does not grow.** Everything the sweep touches is still under RLS.
Which rows one policy admits is inspectable in `packages/db/src/rls.ts`, and asserted in the unit
suite and against Postgres.

**A seventh scope is not licensed by this one.** The argument rests on the flag's branch naming
exactly the rows that are safe to reach. A scope whose branch is the flag alone is ADR 0021's
shape, and needs ADR 0021's argument.

## Alternatives rejected

**A flag with no predicate, like the poller's, and the lapse condition in the statement only.**
Simpler, and the policy would then trust every statement written under the flag. A DELETE is
filtered by `USING` alone, so one wrong `WHERE`, or a shorter interval in a later edit, clears live
revocations for every tenant. Nothing would fail, because revocation is rare enough that no test
trips on its absence. The predicate in the policy makes that edit impossible rather than unlikely.

**A transaction per tenant.** Sweep each tenant under `withTenant`. It needs no new scope. It
needs the tenant list, which `tenants`' own policy will not hand to a connection with no tenant.
And it is ten transactions every quarter hour today, and a thousand at scale, to delete almost
nothing.

**A `SECURITY DEFINER` function owned by `app_admin`.** Rejected for ADR 0021's reason:
`app_admin` is created `NOLOGIN` with no password so that no automated process holds it, and
granting the runtime role `EXECUTE` on a function running as it would undo that on purpose.

**No sweep for this table.** Revocations are rare, and the table would stay small for years. It
would also be a table under `FORCE` row-level security with no way to delete its rows at all,
except as `app_admin` by hand. And P2-14's alarm, which exists to catch a sweep that silently does
nothing, would have one fewer table to catch it on.
