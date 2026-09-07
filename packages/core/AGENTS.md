# packages/core

Domain rules and the per-request context. No HTTP, no AWS — so its tests need
neither a server nor a mocked cloud.

## Invariants

- Domain errors carry **no HTTP status codes**. The same failure means different
  things to different callers: "no such product for this tenant" is a 404 to the
  API and a dropped message to the worker (P0-55).
- The mapping from domain kind to status is a `Record<DomainErrorKind, …>` in
  `apps/api`, so adding a kind without deciding its status is a typecheck
  failure (P0-55).
- A `DomainError`'s message is written for the caller and reaches them verbatim.
  Nothing else's message ever leaves the process (P0-55).
- `packages/core/src/auth.ts` is the **only** file permitted to reach the
  database un-scoped, and the P0-09 rule names it explicitly. A second consumer
  is a boundary violation, not a review comment (P0-45).
- Queries belong in `packages/db`. This package decides; it does not select
  (P0-47, P0-53).
- The request context is `AsyncLocalStorage`, never a module-level variable —
  Lambda serves one request per container but `sst dev` and the test suite do
  not, and a shared global attributes one tenant's actions to another (P0-55).

## Source of truth

`errors.ts` for what can go wrong, `members.ts` for how a tenant is resolved,
`request-context.ts` for what an audited action records.
