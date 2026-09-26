# 0026. The secret key is a seventh RLS scope, and it reaches one row

Status: Accepted
Date: 2026-09-26

Rows: P4-10, P4-09, P2-07

## Context

P4-10 lets a seller's own server mint a widget session with its secret key — the only integration a
page cannot spoof (§3.2, layer 3). The request carries `Authorization: Bearer sk_live_…` and the
origin the session is for. It does not carry a tenant, and it cannot: the key _is_ how the tenant is
identified, exactly as the public key is on the browser path.

Every table involved — `widget_keys`, `tenants`, `tenant_domains` — carries a forced
`tenant_isolation` policy. A lookup of `widget_keys` by `secret_key_hash` on a connection with no
tenant set returns nothing, correctly. The browser path met the same wall and ADR 0022 answered it
with `withWidgetKey`, a fifth scope keyed on the public key and the origin together.

That scope does not fit here. It admits a key row by _public_ key and a domain row by _origin_, and
this request has neither a public key nor a browser-verified origin — it has a secret, and an origin
the caller merely claims.

## Decision

A seventh scope, `resolveTenantBySecretKey`, and it is narrower than any before it.

- **One GUC, `app.secret_key_hash`, and one policy branch, on `widget_keys` alone:** a row is
  admitted when `secret_key_hash` equals the GUC **and `revoked_at IS NULL`**. The second clause is
  load-bearing. P4-08 carries the secret hash onto the new row when the public key rotates, and the
  revoked row keeps its copy through a 24-hour grace; without the clause a rotated-away row would
  still answer to the secret.
- **It finds the tenant and then stops being itself.** Having read the one key row, the scope clears
  `app.secret_key_hash` and sets `app.tenant_id` from that row, in the same transaction. Everything
  after — the tenant's status, its verified origins — is read under the ordinary tenant policy. No
  other table gets a branch.
- **`READ ONLY`**, as `withWidgetKey` is. The request path is driven by an unauthenticated caller
  until the key verifies, and a scope that cannot write cannot be turned into a write.
- **`WITH CHECK` stays tenant-only**, so even without the read-only transaction the branch could not
  write a row.
- **A partial unique index on `secret_key_hash` where `revoked_at IS NULL`.** A key maps to exactly
  one active row. With 256-bit keys a collision never happens by chance; the index makes the bug
  that would produce one — a key authenticating as whichever tenant `LIMIT 1` happened to return —
  a constraint violation instead of a silent wrong answer.
- **Refused inside `withTenant`**, for ADR 0022's reason: with both GUCs set, a tenant-scoped read
  would OR in a row the tenant did not own.

## Alternatives rejected

**Extend `withWidgetKey` with a secret-key branch.** It would put a secret and a public key in one
scope with one set of policy branches, and a bug in either would reach the other. The two keys have
opposite threat models — one is public by construction, the other must never be — and they should
not share a failure mode.

**Look the key up as `app_admin`.** The role bypasses RLS. It is the one sanctioned un-scoped path
into tenant data being quietly duplicated on the request path most exposed to the internet, which
CLAUDE.md forbids in so many words.

**Carry a tenant id in the request.** Reading a tenant from request input is P0-48's prohibition,
and it would buy nothing: the key still has to be verified against that tenant's row, which is the
same lookup with an attacker-chosen hint in front of it.

## Consequences

- Seven scopes. Each is another way a row becomes visible, and this one admits a single row of a
  single table, for the length of one read-only transaction, before handing over to `withTenant`.
- The partial unique index means test seeders can no longer share a placeholder secret hash across
  active rows. They were updated to derive one per tenant.
- **A request presenting a secret key must never be answered from a browser context**, and the
  route enforces that separately: it refuses any request carrying an `Origin` header before it looks
  at the key. A secret key in browser code is a leak, and making it structurally unusable there is
  worth more than documenting that it should not be put there.
