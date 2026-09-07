# 0008. Drizzle, because the SQL has to stay reachable

Status: Accepted
Date: 2026-09-05

## Context

Two things this product does are not expressible in a typical ORM's query builder: pgvector's
`<=>` distance operators, and the session-scoped `set_config` that RLS policies read.

## Decision

Drizzle ORM with the `postgres-js` driver.

## Consequences

Drizzle is SQL-first, so raw fragments sit beside typed queries without ceremony, and
`getTableConfig` makes table declarations introspectable — which is what lets the RLS policy
generator and the reflection tests work at all.

It is also younger and thinner than the alternatives: migrations are generated but the
reverse of each is hand-written here, because Drizzle does not produce one.

## Alternatives rejected

**Prisma** hides SQL by design, which is the opposite of the requirement, and its migration
engine would fight the bootstrap/migration role split. **TypeORM** brings a decorator model and
a history of surprising query generation.
