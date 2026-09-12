# apps/dashboard

Vite + Preact SPA, static, served from S3 behind CloudFront. The shell is built
(P0-57); the catalogue (P1-10b) is the first real screen, and the rest are
still placeholders.

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
- Build both clients on demand, never at module scope. `createAuthClient`
  resolves its base URL at construction and throws on a relative one, and
  `createClient` captures `globalThis.fetch` at construction — a module-level
  instance freezes whichever `fetch` existed at first import (P0-57).
- The active winery lives in `localStorage`, and a remembered id that is no
  longer a membership is ignored rather than replaced by the first one.
  Defaulting would move somebody into a different winery silently (P0-57).

## Source of truth

The generated API client (P0-63), which comes from the route table. Never
hand-write a request shape.
