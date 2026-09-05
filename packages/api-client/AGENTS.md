# packages/api-client

The typed client both consumers use instead of raw `fetch`.

## Invariants

- **Never call our own API with raw `fetch` outside this package.** An ESLint
  rule enforces it, and the rule is what keeps the consumer map complete — a
  hand-maintained list of call sites is wrong the first time somebody adds one
  (P0-63).
- `src/types.generated.ts` is **generated**. Edit the route table in
  `apps/api/src/surfaces/dashboard.ts` and re-run `pnpm client:gen`; a hand edit
  is overwritten and the drift check fails (P0-63).
- The widget imports **types only**. Its bundle budget is a product constraint,
  so the runtime wrapper stays small and hand-written rather than generated
  (P3-05, P0-63).

## Source of truth

`DASHBOARD_ROUTES` in `apps/api`. The OpenAPI document and these types are two
projections of it, which is why a breaking response change fails typecheck in
both consumers rather than surfacing in a seller's storefront.
