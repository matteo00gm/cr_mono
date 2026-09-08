# 0020. Provider webhooks are a third surface, applied in one un-scoped transaction

Status: Accepted
Date: 2026-09-08

## Context

`apps/api` served exactly two prefixes, and both authenticate a _caller_:
`/v1/dashboard/*` reads a session cookie and scopes the request to a tenant from
`memberships`, `/v1/widget/*` accepts an origin-bound token issued to a seller's
site. Both then have a tenant, and every query they issue runs inside
`withTenant`.

Resend's bounce and complaint events fit neither. There is no person, no site,
no session and no tenant — a provider POSTs to us, and the only evidence that it
is really them is an HMAC over the bytes they sent. The tenant cannot be derived
either: a bounce is a fact about an _address_, and the address may have been
mailed by any winery or by none.

Stripe (P0-33) needs the same thing with a different signature scheme, and
Shopify (P6-07) after that. Deciding this once, for a surface rather than for an
endpoint, is what stops the third one being invented from scratch.

The forcing constraint on the storage side is P0-64's suppression list. It is
deliberately global — a bounce one winery caused must stop every winery mailing
that address, because the reputation being protected belongs to the sending
domain — so it carries no `tenant_id` and no RLS policy, exactly like
`processed_webhooks`.

## Decision

Webhooks are a third Hono surface at `/v1/webhooks/*`, with its own route-access
table checked at boot, and no session or tenant middleware anywhere above it.
Authentication is signature verification over the **raw** body, before any
parse.

Events are applied through `withWebhookEvent`, which opens an **un-scoped**
transaction, claims the event id in `processed_webhooks`, and runs the work
inside that same transaction.

## Consequences

The claim and the effect commit or roll back together, so a failed delivery
leaves nothing claimed and the provider's redelivery repairs it. That is the
property the whole shape exists for: claiming separately leaves a window where
an event is recorded as processed and the work never happened, and the one
mechanism that would have fixed it is then refused.

There is now a second un-scoped, GUC-free connection path in `packages/db`, after
`createRateLimiter`. This is the cost, and it is real: the repository's stated
rule is that `withTenant` is the only way to reach the database, and each of
these is a place that is not. What keeps them safe is narrow and worth stating —
every table they touch has no `tenant_id` and no policy, so there is no scoped
read for a missing context to silently narrow and no other tenant's rows to
widen into. That stops being true the moment one of these functions touches a
tenant table, which is why the set of tables is named in `AGENTS.md` and closed.

A signature-authenticated endpoint is reachable by the whole internet, which
makes the boot-time access declaration (P0-49) matter more here than on the
dashboard, not less. It is also why the response says only that verification
failed: a `DomainError`'s message reaches the caller verbatim, and naming the
failing check would be a tutorial.

Status codes now mean something specific on this surface: they are chosen by
whether a redelivery could help. Svix retries every non-2xx on a schedule
spanning hours and eventually disables an endpoint that keeps failing, so a
payload we cannot read is acknowledged with 200 and logged, while a database
failure is left to become a 500 precisely so it _is_ retried.

The endpoint is absent from the OpenAPI document. That reference describes what
callers may use, and this URL is not an offer to anyone.

## Alternatives rejected

**A route on the dashboard surface.** It would sit below `requireUser` and 401
every delivery — loud, at least — or force the guard to be moved, which is the
quiet version: `requireUser` registered anywhere above the widget's routes is
how a public surface silently acquires cookie handling. Structure beats a rule
reviewers must remember.

**Deriving a tenant and using `withTenant`.** There is nothing to derive from. A
bounce names an address, not a winery, and the same address may have been mailed
by several — which is the reason the suppression list is global in the first
place. Choosing one tenant to satisfy the rule would record the fact in a scope
that is wrong.

**A fourth GUC and a policy admitting it**, in the shape of `withUser` and
`withInvitation`. Those two are second _scopes_: each sets a setting and reads
under a policy that admits it, so everything they can see is still governed. A
GUC here would govern nothing, because the tables involved have no policies to
consult — it would be ceremony that reads as protection, which is worse than an
honest un-scoped path with a written reason.

**A shared secret in a header, as the origin guard uses (A2).** A bearer token
proves nothing about the body. The attack this surface must survive is a
captured legitimate delivery re-sent with a different recipient — which would
suppress an address of the attacker's choosing and lock a real customer out of
password reset, using our own bounce machinery. Only a signature over the body
closes that.

**Verifying `JSON.stringify(await c.req.json())`.** A signature is over bytes.
Key order, whitespace and number formatting all differ after a round trip, so
the check would fail for every legitimate delivery — and the natural way to make
it pass is to loosen it until it proves nothing.
