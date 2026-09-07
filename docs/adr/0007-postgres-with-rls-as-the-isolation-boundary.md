# 0007. Row Level Security as the tenant isolation boundary

Status: Accepted
Date: 2026-09-05

## Context

This is a multi-tenant product where one seller reading another's catalogue is the worst thing
that can happen. Application-level filtering — a `WHERE tenant_id = ?` on every query — is
correct exactly as long as nobody forgets one, and there is no way to prove nobody has.

## Decision

One Postgres database with a shared schema, `tenant_id` on every tenant-scoped table, and
`ENABLE` plus `FORCE ROW LEVEL SECURITY` with policies carrying both `USING` and `WITH CHECK`.
The runtime role is `app_rw`, which is `NOBYPASSRLS` and owns nothing.

## Consequences

Every query must carry tenant context, which is why `withTenant()` is the only sanctioned path
to the database and why a dependency-cruiser rule enforces that structurally (P0-19, P0-09).
A query issued outside it returns nothing rather than everything, which is the right direction
to fail.

The cost is real: connection-scoped GUCs mean `SET LOCAL` inside a transaction, tests need a
container rather than a mock, and the roles have to be got right — the application connecting as
the RDS master would make every policy inert while the whole suite stayed green, which is a
mistake this repository actually made and corrected (P0-21a).

## Alternatives rejected

**Database-per-tenant** isolates perfectly and does not fit the cost model at this scale, nor
migrate cleanly across hundreds of tenants. **Application-level filtering alone** is one
forgotten clause away from a breach, and nothing structural prevents that clause being
forgotten.
