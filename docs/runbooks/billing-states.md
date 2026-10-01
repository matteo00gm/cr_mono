# Putting a winery in any billing state

Every non-paying case is one a seller's shoppers see first, under the strict
no-grace policy (§5.2b). Waiting for a real card to fail is not a test
strategy, and editing `tenants.status` by hand proves nothing about the
webhook path. Three ways in, each for a different job (P5-14).

## 1. A fixture per state, locally

With the local stack running and its `app_rw` URL to hand:

```bash
DATABASE_URL=<app_rw url> pnpm seed:states --serve
```

It seeds eight wineries, prints each one's status, expected widget, storefront
origin and public key, and with `--serve` puts a storefront on each origin
(ports 4201–4208) carrying the widget against `API_ORIGIN`
(default `http://localhost:3001`). Every paid state is reached by a
Stripe-shaped event recorded through the webhook port, so the state machine is
what put it there. Refused when `SST_STAGE` is `production`.

| Fixture                | Status                                       | Widget          |
| ---------------------- | -------------------------------------------- | --------------- |
| `trialing-fresh`       | `TRIALING`, 0/150 used                       | answers         |
| `trialing-capped`      | `TRIALING`, 150/150 used                     | quota exceeded  |
| `trialing-expired`     | trial date passed                            | off             |
| `active-healthy`       | `ACTIVE`                                     | answers         |
| `active-capped`        | `ACTIVE`, 1,500/1,500 used                   | quota exceeded  |
| `past-due`             | `ACTIVE` → payment failed → `PAST_DUE`       | off, at once    |
| `subscription-ended`   | `ACTIVE` → subscription deleted → `DISABLED` | off             |
| `pending-verification` | no verified domain                           | nothing renders |

## 2. One winery, by hand, off production

`POST /v1/dev/billing-state` with `{"transition": "activate" | "fail_payment" |
"recover" | "end_subscription", "plan"?: "CANTINA" | "ECOMMERCE"}` moves the
signed-in owner's own winery, through the same webhook path. It needs
`billing:manage` and a second factor, like every owner action. **It does not
exist in production**: the composition root never wires it there, and the API
refuses to start if it ever finds the port or a `/v1/dev` route in a
production app.

## 3. Stripe itself, in test mode

For what only Stripe's own clock and card network can do. Needs a test-mode key
(`sk_test_…`) for the stage's Stripe account; the helpers refuse anything else.

- **`4000 0000 0000 0341`** attaches and then fails on the recurring charge —
  the card that produces a genuine `invoice.payment_failed` on renewal.
- **`4000 0000 0000 0002`** declines at Checkout.
- **Test clocks** (`packages/testing/src/stripe-clock.ts`): create a clock,
  create the customer on it, subscribe through Checkout, then advance the clock
  past the period end to reach the renewal — and past each retry for a renewal
  that fails. `advanceTestClock` waits until Stripe has run everything due.

Our trial is card-free and lives in `tenants.trial_ends_at` (P5-05a), so a test
clock does not end it: trial expiry is the date passing, read at the gate.
