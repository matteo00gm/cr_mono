# apps/e2e

The cross-origin browser suite (P3-18): the API on a port, the built widget on
two origins, and Chromium driven at both.

## Invariants

- **This app ships nothing.** No `build` script, no `dist`, in no runtime
  dependency graph. It is the one consumer _downstream_ of every app, which is
  why the packages-may-not-import-apps rule is switched off for it in
  `eslint.config.js` and nowhere else (P3-18).
- **The model is the only thing that is scripted.** P1-47 forbids paid provider
  calls without agreed spend, and nothing here asserts model quality. Everything
  beneath it is real: the middleware chain, key resolution against Postgres as
  `app_rw`, the session mint, the SSE stream, the cart post (P1-47).
- **The suite runs against the _built_ bundle**, never source. Both defects it
  found on its first run — `import.meta` in a classic script, and a bare
  `button` selector styling the whole panel — are invisible to a suite that
  imports source into JSDOM (P3-18).
- **`environment: 'development'`, deliberately.** P2-05's production rule
  refuses `http:` and `localhost` outright, so a production-mode harness would
  refuse both ports and the unverified case would pass for the wrong reason.
  Development relaxes normalisation only; membership of `tenant_domains` is
  decided identically either way, which is the thing under test (P2-05).
- **Serial, one worker, no retries.** One database and one API are shared, and
  one test un-verifies the domain the others depend on — restored in
  `beforeEach`. A retry would hide a flake in the suite that proves the browser
  enforces CORS (P3-18).
- Not part of `pnpm test`. It needs Docker _and_ a downloaded browser; `pnpm e2e`
  is the entry point and CI gives it its own job (P3-18).

## Source of truth

`test/setup.ts` for how the stack is assembled; `test/cross-origin.spec.ts` for
what it proves. The host pages and the API harness live in
`@catalogorosso/testing` (P3-17).
