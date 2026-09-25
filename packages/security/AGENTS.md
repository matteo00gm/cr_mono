# packages/security

Security primitives with no AWS in them, so their tests are plain unit tests
with no mocked cloud.

**The one thing here that speaks HTTP is `guardedFetch`**, and it is on the
`./net` subpath rather than the barrel on purpose: it reaches for `node:https`
and `node:dns`, and the barrel is bundled into the dashboard, where a browser
build that resolves `node:dns` fails (P4-03a).

## The bar

**100% lines, statements, functions and branches**, enforced by the coverage
gate — and this package is in P4-16's mutation run. That is the standard before
writing, not a target to reach afterwards.

## Invariants

- Redaction is an **allowlist**. A denylist protects the fields somebody
  remembered; the next field added leaks by default (P0-56).
- `SAFE_KEYS` governs every key at every depth for every caller. Adding a name
  for one call site opens it everywhere — `message` and `code` are absent
  deliberately, and a guard test asserts they stay absent (P0-56).
- The capability table is the only place a role is compared to anything.
  Scattered `if (role === 'OWNER')` cannot be enumerated, and anything that
  cannot be enumerated cannot be shown to be complete (P0-49).
- `Role` lives here rather than in `core`, because `core` depends on this
  package for redaction and the reverse edge would be a cycle (P0-49).
- An address is validated **at socket connect**, inside the connection's own
  `lookup`, never by resolving and checking before the fetch. The second form
  passes every test and is defeated by a nameserver that answers the second
  lookup differently — which an attacker who chose the hostname controls by
  definition (P4-03a).
- `guardedFetch` follows **no redirects at all**. A 302 to `169.254.169.254`
  gets its own connection, and that connection would not be the one these
  checks are attached to (P4-03a).
- Nothing tenant-supplied goes into an outbound request's headers, so this
  cannot become a way to send data somewhere of an attacker's choosing
  (P4-03a).

## Source of truth

`CAPABILITIES` and `SAFE_KEYS`. P0-50's generated matrix reads the first;
P0-53's audit writer scrubs through the second.
