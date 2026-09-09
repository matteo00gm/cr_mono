# catalogorosso

A multi-tenant SaaS RAG platform: Italian wine sellers embed a widget, their
customers ask for recommendations, and the answers come from that seller's own
catalogue. One database, one API, many tenants.

## Commands

```bash
pnpm test              # unit suites, no Docker
pnpm test:integration  # real Postgres via Testcontainers, needs Docker
pnpm lint              # per-package eslint
pnpm typecheck         # per-package tsc --noEmit
pnpm boundaries        # architectural rules that lint cannot express
pnpm build             # required before the integration suite: it imports dist
sst dev --stage <you>  # local code against real AWS events
```

## Packages

| Package             | What it is                                                        |
| ------------------- | ----------------------------------------------------------------- |
| `packages/db`       | Drizzle schema, migrations, RLS policies, `withTenant`            |
| `packages/core`     | Domain rules and the request context. No HTTP, no AWS             |
| `packages/security` | Redaction, capabilities. No HTTP, no AWS. 100% branch coverage    |
| `packages/testing`  | Container harness and fixtures. Never imported by production code |
| `apps/api`          | Hono on Lambda. Two surfaces: `/v1/dashboard`, `/v1/widget`       |
| `apps/worker`       | SQS consumer: embedding, sync, webhooks, rollups                  |
| `apps/dashboard`    | Vite + Preact SPA, static                                         |
| `apps/widget`       | Two bundles: a tiny loader and the lazy-loaded widget             |

## Invariants

These are prohibitions, and each one is a security bug waiting for somebody who
does not know it. They cannot be inferred from any single file — an experienced
reader might find them by reading tests, and a model generating a plausible
patch will not, because the ORM's own documentation shows the forbidden form.

**Database**

- Never query the database outside `withTenant()` — RLS reads
  `current_setting('app.tenant_id')`, and a query issued without it returns
  nothing, or returns another tenant's rows once somebody "fixes" that with a
  default (P0-19).
- There is exactly **one** sanctioned un-scoped path _into tenant data_, named
  in the boundary rules: `@catalogorosso/db/auth`, for the Better Auth adapter,
  which runs before a tenant is known (P0-45). Everything else that looks like
  an exception is a second _scope_, not an escape from scoping: `withUser()`
  (P0-47) and `withInvitation()` (P0-51) each set a different GUC and read
  under a policy that admits it. A new one of those is a design change — every
  GUC is another way a row becomes visible.
- Three tables carry **no `tenant_id` and no policy on purpose**, and are
  reached on connections that set nothing: `rate_limit_buckets` (P0-34),
  `processed_webhooks` (P0-33) and `email_suppressions` (P0-64). Their callers
  are named too — `createRateLimiter` (P2-02) and `withWebhookEvent` (P0-64b) —
  because the safety is narrow and specific: there is no scoped read for a
  missing context to narrow, and no other tenant's rows to widen into. That
  stops being true the instant one of these touches a tenant table. The set is
  closed; adding to it is a design change (ADR 0020).
- Never read a tenant id from request input — body, query, path or header. It
  comes from a `memberships` row for the authenticated user (P0-48).
- Never hand-write a type that duplicates a table's shape. Contracts are
  derived from the schema with `drizzle-zod` (P0-42).
- Never grant the runtime role a way to rewrite a ledger. `audit_log`,
  `usage_events`, `security_events` and `processed_webhooks` are append-only at
  the grant level, and `app_rw` cannot delete a tenant (P0-31, P0-33a).
- Every migration has a hand-written reverse in `migrations/down/` (P0-40).

**API**

- Register middleware _before_ the routes it guards. Hono matches handlers in
  registration order, so a `use()` below a `get()` never runs — and the route's
  own tests all still pass (P0-54).
- Every dashboard route declares its access: a capability, or
  `publicRoute(reason)` with a written reason. An undeclared route fails at
  startup rather than defaulting to open (P0-49).
- Never return a non-`DomainError`'s message to a caller. Its `.message` can
  hold a connection string or another tenant's data, and a driver error
  routinely does (P0-55).
- A `DomainError`'s message _is_ the API contract and reaches the caller
  verbatim — so it must never carry a secret or answer a question the caller was
  not entitled to ask (P0-55).
- A cross-tenant id returns 404, not 403. The difference tells an attacker the
  resource exists (§3.5, P0-47).

**Secrets and logging**

- The log redaction allowlist governs every key at every depth for every
  caller. Adding a name for one call site opens it everywhere — `message` and
  `code` are the live examples of names that look harmless and are not (P0-56).
- Never write a key-shaped literal into a file, including a test fixture. Build
  it at runtime; the P0-08 history scan finds literals and they cannot be edited
  out once pushed (P0-56).
- `audit()` takes the caller's transaction, never its own. An audit row for an
  action that rolled back is worse than none, because it is a record people
  will believe (P0-53).

**Widget and model output**

- Never use `innerHTML` or `dangerouslySetInnerHTML` in the widget. Text nodes
  only (§3.7, P3-08).
- Never render a card from model output. The model supplies a `productId` and a
  reason; every displayed field comes from our own catalogue (P2-25).
- CORS matching is exact-set equality. Never a regular expression, never
  `startsWith`, never `endsWith` — suffix matching is defeated by
  `evil-example.com` (§3.4, P2-08).
- Every outbound fetch to a user-supplied host goes through `guardedFetch`
  (P4-03a).

## Verifying

Two rules this repository has been burned by, both worth more than they look.

**A guard that cannot fail is not a guard.** Before trusting a new check, break
the thing it guards and watch it fire. The P0-09 boundary rule passed for
exactly as long as the driver was uninstalled.

**Verifying an install fix in a tree that already has `node_modules` proves
nothing.** CI starts from a fresh checkout; reproduce there or in a fresh
worktree.

## Where the reasoning lives

`plan-v1.md` is the source of truth for task specifications, as-built
deviations and open items. `docs/adr/` holds the standing decisions. When
implementation contradicts the plan, update the plan in the same PR and say why.
