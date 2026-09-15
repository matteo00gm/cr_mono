# 0022. The widget key and origin are a fifth RLS scope, and it cannot write

Status: Accepted
Date: 2026-09-15

## Context

Every widget request starts by answering one question: which tenant is this? The only evidence is
the public key in the query string and the `Origin` the browser sent, and §3.2 requires both to
agree on one tenant. That question is asked before any tenant is known — answering it _is_ the
resolution — so `withTenant` cannot be used.

The three tables it needs are `widget_keys`, `tenant_domains` and `tenants`. All three carry a
forced `tenant_isolation` policy, so a query as `app_rw` with no `app.tenant_id` returns zero rows.

P2-07's row says to run the query "outside `withTenant`" with a lint exemption. That does not work,
and the reason is the database, not the lint rule: under `FORCE ROW LEVEL SECURITY` there is no
un-scoped read for `app_rw` to make. Making it work would need a role that bypasses RLS on the
path an unauthenticated visitor's browser drives. The repository also now says, in the root
invariants, that there is exactly one sanctioned un-scoped path into tenant data, and that a new
scope is a design change. This is that change.

## Decision

A fifth scope, `withWidgetKey(publicKey, origin)`, beside `withTenant` (P0-19), `withUser` (P0-47),
`withInvitation` (P0-51) and `withOutbox` (P1-31, ADR 0021). It sets two transaction-local GUCs,
`app.widget_key` and `app.widget_origin`, and migration `0042` replaces `tenant_isolation` on the
three tables:

```sql
-- widget_keys
USING      (tenant_id = app.tenant_id OR public_key = app.widget_key)
-- tenant_domains
USING      (tenant_id = app.tenant_id
            OR (origin = app.widget_origin
                AND tenant_id IN (SELECT tenant_id FROM widget_keys WHERE public_key = app.widget_key)))
-- tenants
USING      (id = app.tenant_id
            OR id IN (SELECT tenant_id FROM tenant_domains
                      WHERE origin = app.widget_origin AND status = 'VERIFIED'
                        AND tenant_id IN (SELECT tenant_id FROM widget_keys
                                          WHERE public_key = app.widget_key)))
WITH CHECK (the tenant branch alone, on all three)
```

**It narrows, in order.** The key reaches one key row. The origin reaches one domain row, and only
the one belonging to that key's tenant. The tenant row is reachable only behind a _verified_
domain. A key alone never reaches a tenant, and an origin alone reaches nothing.

**It cannot write, twice over.** The transaction opens `READ ONLY`, so an `INSERT`, `UPDATE` or
`DELETE` inside it fails whatever the policies admit. And `WITH CHECK` stays tenant-only, so even
outside a read-only transaction the widget branch would buy no write. The first bound is the one
ADR 0021 lacked: a `DELETE` is filtered by `USING` alone, so under an admitting branch it matches
the admitted rows. 0021 closed that on `outbox` by revoking `DELETE`, which cannot be done on
`tenant_domains`, where removing a domain is a real operation. A read-only transaction closes it
for every table at once.

It refuses to open inside `withTenant`, as `withUser` does, because both GUCs together would OR
each policy's branches into a read wider than either.

## Consequences

**The cost, stated first.** Anything running as `app_rw` can now set two GUCs and read, for a
given public key: the key's row, including `secret_key_hash` (argon2id, never a plaintext), and —
if it also names the tenant's verified origin — that domain row and the tenant row. Public keys and
verified origins are public by design; they are on the seller's own page. So what this adds is
column exposure of rows whose _existence_ was already public, reachable only by code that sets the
GUCs. `resolveTenantByKeyAndOrigin` selects the tenant id, the key's revocation state, the tenant's
status, plan and locale, and nothing else.

**This is not a narrowing secret, and should not be read as one.** `withInvitation`'s token is a
256-bit secret held by the user, so presenting it is the authorisation. A public key is an
identifier. What bounds this scope is the combination of the two values, the verified-domain gate
on the tenant row, and the read-only transaction — not the unguessability of either input.

**Every read of the three tables pays a subplan.** The added branches are uncorrelated subqueries
against unique indexes, evaluated once per query, and they return nothing when the GUCs are unset.
That is cheap at this scale, and it is the price of keeping one policy per table.

**The sanctioned un-scoped list does not grow.** `@catalogorosso/db/auth` remains the only path to
a connection with no policy in front of it.

**Reversal restores the boilerplate.** The down migration re-creates each table's previous
`tenant_isolation`, as ADR 0021's `supersedes` mechanism requires. It does not disable RLS.

**A sixth scope is not licensed by this one.** The argument rests on the inputs being public, the
reachable rows being ones whose existence is already public, and the transaction being read-only.
It does not transfer to a table holding anything a seller or visitor wrote.

## Alternatives rejected

**An un-scoped connection with a lint exemption, as the row says.** Under forced RLS it returns
nothing for `app_rw`, so it only works for a role that bypasses RLS, on the request path.

**A `SECURITY DEFINER` function owned by `app_admin`.** Tighter in one way — the unlock would be
one fixed statement — and rejected for ADR 0021's reason: `app_admin` is created `NOLOGIN` with no
password so that no automated process holds it, and granting `EXECUTE` on a function running as
that role would undo that on purpose.

**A denormalised lookup table with no policy**, `(public_key, origin) → tenant_id`, in the style of
`rate_limit_buckets`. It needs no GUC. It adds a fourth table to the closed no-policy set (ADR
0020), and it is a second copy of the allowlist that has to be kept in step with every rotation,
revocation and domain removal — exactly the stale-authorisation failure §5.7 defers caching to
avoid.

**A second, narrower policy per table** (`FOR SELECT ... USING (widget branch)`). Permissive
policies are OR-ed, so it bypasses `tenant_isolation` rather than refining it, and
`rls-coverage.integration.test.ts` refuses any policy but `tenant_isolation` for that reason.

**Two queries — key first, then domain under `withTenant(keyTenant)`.** It needs no new policy on
`tenant_domains` or `tenants`, but the first query still has no context to run in, so it moves the
problem rather than solving it.
