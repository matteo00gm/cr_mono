# 0012. Better Auth, self-hosted in our own Postgres

Status: Accepted
Date: 2026-09-05

## Context

Authentication for the dashboard could be bought or built. Buying it removes a class of risk;
hosting it removes a per-seat cost and a dependency on someone else's availability and pricing.

This reverses an earlier decision in favour of a hosted identity provider, and the reversal is
deliberate rather than a drift.

## Decision

Better Auth, self-hosted, with its tables in the same Postgres database, reached through the
Drizzle adapter.

## Consequences

**What we now own is the list, and it is not short**: password hashing parameters, reset-token
generation and single-use enforcement, account enumeration including timing, rate limiting on
auth endpoints, session fixation and revocation, TOTP correctness, and keeping the library
patched — it is in the security-critical path, so it belongs on a watch list rather than in an
auto-merge group.

P0-46 exists to make that list defensible rather than hopeful, and it immediately found three
ways the deployment disarmed the library's own defaults: AWS Lambda does not set `NODE_ENV`, so
rate limiting resolved to _off_; enabling it alone would have put every caller in one shared
bucket; and the client address needed pinning at the edge.

It also introduces the one sanctioned un-scoped database path: authentication must identify a
user _before_ a tenant is known, so the adapter cannot go through `withTenant()`.

## Alternatives rejected

**A hosted IdP** removes the list above and adds a per-seat cost, a second availability
dependency, and a vendor whose pricing changes are not ours to decide.
