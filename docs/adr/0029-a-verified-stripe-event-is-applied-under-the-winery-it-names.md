# 0029. A verified Stripe event is applied under the winery it names

Status: Accepted
Date: 2026-09-30

Rows: P5-02, P5-03, P5-04, P5-05, P0-48, P0-64b

## Context

A Stripe event moves a winery's billing state: its status decides whether the widget serves at all
(§1.3, §2.5). The event arrives on the webhook surface with no session, no membership and no
tenant — the only evidence it is Stripe's is the signature P5-03 checks over the raw body.

Two rules meet here. **P0-48**: a tenant id is never read from request input; it comes from a
`memberships` row for the authenticated user. And **P5-04**: the idempotency claim in
`processed_webhooks` and the state change must commit in one transaction, or a crash between them
marks an event processed that was never applied — permanent, silent, and indistinguishable from
success.

`withWebhookEvent` (P0-64b) already makes the claim and the effect one transaction, but it is
deliberately un-scoped: Resend's effect touches only `email_suppressions`, which is global on
purpose, and the function's header says a handler that reached for a tenant table from inside it
"would be the design change, and would get nothing back". Stripe's effect is on `tenants`.

So the event has to name its winery, and something has to decide whether to believe it. The two
obvious ways to find the winery both cost something. Looking the Stripe customer id up across
`tenants` is a read of every winery's row, which would be a new un-scoped path into tenant data.
Believing an id in the body is, on its face, what P0-48 forbids.

## Decision

A verified Stripe event is applied under the winery it names, in an ordinary `withTenant`
transaction that claims the event first. It is not a new scope and sets no new GUC.

- **We wrote the name.** P5-02 creates every Checkout session server-side from the session's own
  tenant and writes the id into Stripe-signed data: `client_reference_id` and `metadata.tenant_id`
  on the session, and `metadata.tenant_id` on the subscription it creates, which every later
  subscription and invoice event carries. The browser never supplies either. What P0-48 guards
  against — a caller choosing whose rows they reach — is not possible here: the caller is Stripe,
  proven by the signature, repeating what our server told it.
- **The name is read strictly.** `tenantOfStripeEvent` accepts a well-formed UUID only, and an
  event whose fields disagree with each other names nobody. An event that names nobody is
  acknowledged and logged, and changes nothing: it is not ours, or it is from a price somebody
  clicked into the Dashboard.
- **The claim is inside the tenant's transaction.** `withTenantWebhookEvent` opens `withTenant` for
  the named winery and claims `(stripe, event id)` as its first statement. `processed_webhooks`
  has no policy, so the claim behaves as it does un-scoped; the effect that follows runs under the
  tenant policy like any other write. A winery that no longer exists has no row to change, and the
  claim records that the event was handled.
- **The name is bound to the customer on file** before anything is applied (P5-05). The first
  completed Checkout records the customer and subscription; after that, an event whose customer is
  not the one on file for the winery it names changes nothing and is logged. So even an event we
  did not create — a subscription made in the Dashboard with somebody else's `tenant_id` pasted
  into its metadata — cannot move a winery that already has a customer.

CLAUDE.md's P0-48 invariant names this as its one exception, with this ADR.

## Consequences

- **Anybody with Dashboard access to our Stripe account can name a winery.** An operator who
  creates a subscription by hand and types a `tenant_id` into its metadata can move a winery that
  has never bought anything: the binding protects only wineries that already have a customer. That
  is the same trust we already place in whoever holds the account, which can issue refunds and
  cancel every subscription, but it is a real widening and the reason the event reader accepts a
  UUID and nothing else.
- **Metadata becomes a contract with Stripe.** If Stripe stopped copying `subscription_data.metadata`
  onto the subscription, or moved where an invoice carries its subscription's metadata — it did the
  latter in 2025, to `parent.subscription_details` — events would start naming nobody. They would be
  acknowledged and logged rather than misapplied, which is the safe direction, and an alarm on the
  log kind is what notices. The webhook endpoint is created on the pinned API version for the same
  reason.
- **Events that name nobody are claimed by nobody.** They are not written to `processed_webhooks`,
  because there is no winery transaction to write them in. A redelivery of one is acknowledged and
  logged again, which costs a log line.
- **P0-48's lint rule does not see this read**, and cannot: it matches request objects in route
  handlers, and the read is of a parsed, verified event inside core. The exception is recorded here
  and in CLAUDE.md rather than enforced, and `stripe-events.test.ts` pins that nothing else in an
  event is ever taken for a tenant.

## Alternatives rejected

**Look the winery up by Stripe customer id.** It needs a read across every winery's row before any
tenant is known — a ninth scope, with a GUC and a policy branch admitting a row by customer id. It
would also fail for the one event that matters most, the first `checkout.session.completed`, where
no customer id is on file yet, so the metadata would be needed anyway.

**Claim the event un-scoped, then apply it in a second, tenant-scoped transaction.** A crash between
the two leaves the event marked processed and never applied, and Stripe's redelivery — the one
thing that would have repaired it — is refused by the ledger. P5-04 exists to prevent exactly that.

**Apply it as `app_admin`.** The role bypasses RLS, which would make a webhook handler a second
sanctioned un-scoped path into tenant data. CLAUDE.md allows one, for Better Auth, and says why.
