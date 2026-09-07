# `apps/migrator`

The deploy-time database path: bootstrap, then migrations, as a one-shot
Lambda invoked after `sst deploy` (P0-21b).

## Invariants

- Never fold this into `apps/api` or `apps/worker`. P0-21a refuses the
  master and `app_migrate` parameters to every application function — one
  grants a connection that bypasses RLS, the other can alter the schema —
  and a separate function is what keeps that true (P0-21a, P0-21b).
- Never inject the credentials as environment variables. They are read at
  invoke time, because a Lambda environment variable is readable by anyone
  holding `lambda:GetFunctionConfiguration`, permanently, whether or not
  the function ever runs (P0-21b).
- Bootstrap runs as **master**, migrations as **`app_migrate`**. Whoever
  runs a migration owns the tables it creates, and `FORCE ROW LEVEL
SECURITY` does not apply to a table's owner — so running them as master
  makes every P0-37 policy inert for the schema owner (P0-37, P0-21b).
- The SQL directories are passed explicitly. The package-relative default
  in `deploy.ts` resolves from `import.meta.url` and is wrong inside a
  bundle, where it becomes `/var/` (P0-21b).
