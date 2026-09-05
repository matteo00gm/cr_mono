# apps/api

Hono on Lambda. Two route surfaces, one function.

## Invariants

- The two surfaces are **separate `Hono` instances**, not route groups.
  Middleware on a shared parent runs for both children, and P2-08's permissive
  CORS handler reaching the authenticated dashboard is how a cross-origin page
  reads a seller's catalogue (P0-54).
- Register middleware before the routes it guards. Hono matches in registration
  order, so a guard below its route never runs and every functional test of that
  route still passes (P0-54).
- Every dashboard route declares its access in `DASHBOARD_ROUTE_ACCESS` — a
  capability, or `publicRoute(reason)` with a written reason. An undeclared
  route throws while the container is initialising (P0-49).
- Never read a tenant id from request input. An ESLint rule catches the common
  shapes; `middleware/tenant.ts` is its single exception, because it reads a
  _selection_ among rows the database already agrees exist (P0-48).
- Tenant and role come from the same `memberships` row, together. A role cached
  per user grants somebody who is EDITOR on one winery and OWNER on another the
  higher role on both (P0-47).
- Better Auth is mounted on the dashboard surface only. The widget uses
  origin-bound tokens and must not accept cookies at all (P0-45).
- `NODE_ENV=production` on the deployed function is load-bearing for security,
  not cosmetic: Lambda does not set it, and Better Auth then disables rate
  limiting and resolves every caller to `127.0.0.1` (P0-46).

## Source of truth

`src/routes.ts` for where things are mounted, `DASHBOARD_ROUTE_ACCESS` for what
each route requires. P0-50's matrix reads the router, never a hand-written list.
