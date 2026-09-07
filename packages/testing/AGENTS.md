# packages/testing

The Testcontainers harness and the shared fixtures.

## Invariants

- **Production code must never import this package.** It opens un-scoped
  connections and carries Barolo and Chianti rows that would be nonsense in a
  running system. A dependency-cruiser rule enforces it, and that rule is what
  makes this package's own exemption from the raw-database rule safe (P0-44).
- The harness connects as `app_rw`, never the container superuser. A superuser
  bypasses RLS, so a harness that yielded one would make every isolation test in
  the repository pass vacuously (P0-44).
- The Postgres image is pinned **low**, to what RDS actually offers, so a
  capability that works in tests works in production. A floating tag gives that
  guarantee up by changing under a green build (P0-44).
- Key-shaped fixtures are assembled at runtime. A literal is found by the P0-08
  history scan and cannot be edited out once pushed (P0-56).

## Source of truth

`db-harness.ts` for how a suite gets a database; `factories.ts` and
`secrets.ts` for what a suite gets to put in it.
