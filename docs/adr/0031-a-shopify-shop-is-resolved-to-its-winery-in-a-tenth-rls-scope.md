# 0031. A Shopify shop is resolved to its winery in a tenth RLS scope, and its token is not in the database

Status: Accepted
Date: 2026-10-02

## Context

P6-06 connects a winery's Shopify store. Three moments in it have no tenant to scope to.

**The install callback.** Shopify redirects the seller's browser back to us with a code, a shop
and our `state`. The redirect carries no tenant header, and the one sanctioned read of a tenant id
from a request (P0-48, `ACTIVE_TENANT_HEADER`, validated against `memberships`) cannot be made: the
browser is arriving from Shopify. The `state` must say which winery the install was for — and
reading a tenant id out of a query parameter would be a second sanctioned read, of a value the
seller's browser carries.

**A webhook.** `app/uninstalled` now, `orders/create` (P6-07) and `products/update` (P6-11) next:
each is signed with our app secret and names a shop in `X-Shopify-Shop-Domain`, and nothing else.
Which winery holds that shop is in `shopify_installations`, under `tenant_isolation` with `FORCE`. A
handler with no tenant set reads nothing and drops every event, successfully.

**The token.** The offline access token reads the seller's catalogue and orders indefinitely. A
column in a table every tenant-path query can reach is the wrong home for it.

## Decision

**The callback finds its state in the member's own scope.** `shopify_oauth_states` gets
`tenant_isolation` with the `memberships` shape: `USING (tenant_id = app.tenant_id OR user_id =
app.user_id)`, `WITH CHECK (tenant_id = app.tenant_id)`. The install route writes the state in the
member's winery, with the member's user id and the hash of a 256-bit nonce. The callback, already
authenticated by the session cookie, opens `withUser` for that user and _deletes_ the row whose hash
matches — the check and the spending in one statement, so a replay or a race finds nothing. The
winery comes from the row the member's own install wrote, and the membership is then re-checked for
`domains:manage` before anything is installed. The `state` parameter carries only the nonce.

**A webhook resolves its shop in a tenth scope.** `resolveTenantByShop(shop)` sets a
transaction-local GUC, `app.shopify_shop`, inside a `READ ONLY` transaction, selects the
`tenant_id` of the installed row for that shop, and returns it. Migration `0073` gives
`shopify_installations` one more branch:

```sql
USING      (tenant_id = app.tenant_id OR shop = app.shopify_shop)
WITH CHECK (tenant_id = app.tenant_id)
```

No other table admits the flag. The handler then does everything in `withTenant` for the id it was
given. Opening the scope inside a tenant scope is refused, because the branches are OR-ed.

**The token lives in SSM Parameter Store** as a `SecureString` under
`/sommelier/<stage>/shopify/<tenantId>/<shop>`, encrypted with the account's key, put when the install
completes and deleted on `app/uninstalled`. The API role may put, get and delete under that path
and nowhere else. Locally, where there is no SSM, an in-memory store stands in.

## Consequences

**The cost, stated first.** Any code running as `app_rw` that sets `app.shopify_shop` can read one
installation row — which winery holds a shop, and what it granted — for any shop it names. That is
the whole of what the branch admits; it does not reach `tenants`, domains, orders or tokens. What
stops misuse is the boundary rule naming `shopify.ts` as the module that sets it, and review.

**`shopify_oauth_states` joins the user scope**, the second table after `memberships` that a
`withUser` transaction can read. A user can see and spend only states they started.

**A token outlives a database restore.** SSM is not in the database's backups, so a restore to a
point before an uninstall finds an installation row whose token is gone; the next webhook for it
finds the row, the next API call finds no token, and the seller reconnects. The reverse — a token
deleted from the database but not from SSM — cannot happen, because the database never held it.

**Every webhook pays one extra read-only transaction** before its real work. At the volumes §5.0
allows, that is nothing.

## Alternatives rejected

**The winery's id in the `state`.** It would make the callback's tenant a value the browser carries,
checked against the member's memberships after the fact — the shape P0-48 permits once, for the
active-winery header, and should not permit twice. The member scope finds the same row without it.

**The winery's id in each webhook's address.** Shopify signs the body and not the URL, so the id
would be request input that no signature covers. Resolving the shop the body names is the
signed-input route ADR 0029 takes for Stripe.

**The token encrypted in a column.** It would need an application key, which is a secret in SSM
anyway, and it would put a decryptable credential in every backup, every replica and every query
plan that touches the table. SSM keeps it out of all three.
