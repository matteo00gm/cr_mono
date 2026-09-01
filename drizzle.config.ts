import { defineConfig } from 'drizzle-kit';

/**
 * Migration generation (P0-20).
 *
 * Generated from the Drizzle schema rather than hand-written, so the TypeScript
 * definition and the SQL cannot drift: the schema is the single source of truth
 * and `pnpm db:generate` is the only way a file lands in `migrations/`.
 *
 * No `dbCredentials`, deliberately. That field is only read by `push` and
 * `introspect` — two commands this repo does not use, because both mutate or
 * read a live database from a developer's laptop. Leaving it out means
 * generation cannot reach a database at all, so there is no path where someone
 * accidentally pushes a schema change straight to a stage.
 *
 * `migrations/` is not the whole story: everything requiring privileges the
 * migration role does not have — extensions, roles, grants — lives in
 * `packages/db/bootstrap/` and is applied separately. See `packages/db/README.md`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/db/src/schema/index.ts',
  out: './packages/db/migrations',
});
