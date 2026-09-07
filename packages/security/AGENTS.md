# packages/security

Security primitives with no HTTP and no AWS in them, so their tests are plain
unit tests with no mocked cloud.

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

## Source of truth

`CAPABILITIES` and `SAFE_KEYS`. P0-50's generated matrix reads the first;
P0-53's audit writer scrubs through the second.
