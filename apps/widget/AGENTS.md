# apps/widget

Two bundles — a tiny loader and the lazy-loaded widget — running inside a Shadow
DOM on sellers' own sites. Mostly unbuilt; P3 fills it in.

## Invariants

- **Never `innerHTML`, never `dangerouslySetInnerHTML`.** Text nodes only. This
  code runs on customers' sites, and an ESLint rule enforces it (§3.7, P3-08).
- **Never render a card from model output.** The model supplies a `productId`
  and a reason; every displayed field — name, price, image, stock — comes from
  our own catalogue. A model that invents a wine must not be able to show one
  (P2-25).
- This surface authenticates with origin-bound tokens and **accepts no cookies**.
  P2-08 sets `Access-Control-Allow-Credentials: false`, and a session cookie
  presented here grants nothing (§3.4, P0-45).
- CORS matching is exact-set equality — never a regular expression, never
  `startsWith` or `endsWith` (§3.4, P2-08).
- Consume SSE with `fetch` and a `ReadableStream`, not `EventSource`:
  `EventSource` cannot send an `Authorization` header, which this design
  requires (P3-06).

## Source of truth

The generated API client (P0-63). Bundle size is a product constraint here, not
a preference — P3-16 budgets it.
