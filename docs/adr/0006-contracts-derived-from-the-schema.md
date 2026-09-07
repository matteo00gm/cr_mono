# 0006. Request and response contracts derived from the schema

Status: Accepted
Date: 2026-09-05

## Context

The same product shape is used by the database, the API, the dashboard and the widget. Written
by hand in each place, the four drift — and the drift is silent until a request is rejected in
production for a field the client believed existed.

## Decision

Contracts are generated from the Drizzle table declarations with `drizzle-zod`, and exported
from `packages/db`. Nothing hand-writes a duplicate of a table's shape.

## Consequences

The database schema becomes the single source of truth for validation, which means a column
rename is a compile error in the widget. It also means schema-level types leak into the API's
vocabulary unless the derived schemas are narrowed deliberately — `omit` for server-owned
columns, explicit schemas where a Postgres type has no Zod equivalent.

One of those was found by a guard test rather than by reading: `citext` derives to `z.any()`,
so `tenants.slug` accepted a number until an explicit schema was supplied (P0-42).

## Alternatives rejected

**A hand-written `contracts` package** is a second source of truth by construction, and the
thing it would be kept in sync with is exactly the thing it duplicates.
