# apps/dashboard

Vite + Preact SPA, static, served from S3 behind CloudFront. Mostly unbuilt —
P0-57 scaffolds it.

## Invariants

- **Nav gating by capability is UX, not security.** The API enforces
  authorisation; hiding a link only stops an EDITOR being confused by a Billing
  page they cannot use. Never treat a hidden control as a protected one
  (P0-49, P0-57).
- The tenant is chosen by the user among their own memberships and sent as the
  active-tenant header. It is re-validated against `memberships` on every
  request, so a stale or forged value fails rather than being trusted (P0-47).
- Routing is client-side and served by a CloudFront Function that rewrites
  extensionless paths to `/index.html`. Never reintroduce distribution-wide
  `customErrorResponses` — it turns every API 404 into a 200 carrying this
  app's HTML (P0-17a).

## Source of truth

The generated API client (P0-63), which comes from the route table. Never
hand-write a request shape.
