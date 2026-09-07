# packages/db

Drizzle schema, migrations, RLS policies, and the two scoped ways to reach the
database.

## Invariants

- `withTenant()` is the only sanctioned path for tenant-scoped work, and that
  holds at the _export_ surface: `index.ts` deliberately does not re-export
  `getDb`, because no import rule can catch an app that imports this package
  rather than the driver (P0-19).
- `withUser()` sets only `app.user_id` and is not an exception to that. The
  `memberships` policy admits `user_id = app.user_id` on read, so RLS bounds it
  (P0-47).
- `@catalogorosso/db/auth` is the one un-scoped accessor. It exists because
  authentication happens before a tenant is known, it is named in the P0-09
  rule's targets, and it has exactly one permitted importer (P0-45).
- Every migration has a hand-written reverse in `migrations/down/`. Drizzle does
  not generate one (P0-40).
- Migrations are generated (`pnpm db:generate --name=x`), never hand-edited, and
  `--custom` is for triggers, policies and grants (P0-22).
- Ledger tables are append-only at the grant level, and `app_rw` cannot delete a
  tenant — a cascade is not permission-checked against the invoking role
  (P0-31, P0-33a).
- SQL belongs here. If an app or `packages/core` needs a query, the query moves
  into this package rather than the boundary rule gaining an exception — this
  has now happened twice (P0-47, P0-53).

## Source of truth

The `pgTable` declarations. Contracts, RLS policies and the reflection tests are
all derived from them, so a column added there is a compile error everywhere it
matters.
