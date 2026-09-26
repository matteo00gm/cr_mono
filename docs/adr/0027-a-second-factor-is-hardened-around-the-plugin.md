# 0027. A second factor is hardened around the plugin, not trusted to it

Status: Accepted
Date: 2026-09-26

Rows: P4-11, P0-45, P0-23a

## Context

P4-11 requires OWNER MFA and a fresh second factor for sensitive actions, and names three details
that self-hosting TOTP makes ours: backup codes single-use and stored hashed; a ±1-step window with a
used code rejected on replay; and a step-up check that reads the session from the database, not the
cookie cache.

Better Auth's `twoFactor` plugin (1.7.2, pinned by P0-45) provides TOTP, backup codes and a sign-in
lockout. Reading its source against the row found five places where it does less:

1. Backup codes are stored **encrypted** by default — readable by anybody with the database and the
   auth secret — and compared as plaintext.
2. A TOTP code is accepted as many times as it is sent within its window. The window is right (±1
   step, from `@better-auth/utils/otp`); the replay is not.
3. With a session, verification has **no attempt budget**: `beginAttempt` is a no-op and the
   account lockout counts sign-in attempts only. A stolen cookie could guess step-up codes at the
   path's rate limit indefinitely.
4. For an account already enrolled, `/two-factor/enable` replaces the authenticator and
   `/two-factor/get-totp-uri` returns the live secret, each on a session plus the password. Either
   is a takeover of the second factor — the second one silently.
5. Nothing records when a session last proved a second factor.

## Decision

Keep the plugin, and close each gap around it, in `packages/core/src/auth-mfa.ts`, as a second
Better Auth plugin whose hooks wrap the first's endpoints.

- **Backup codes are HMAC-SHA256s keyed with the auth secret**, through the plugin's own
  `storeBackupCodes: { encrypt, decrypt }` seam, and the code a caller sends is hashed by a
  before-hook so the plugin's comparison compares hashes. Keyed, because ten characters is a
  searchable space for an unkeyed hash; the stored value, presented as a code, is hashed again and
  refused.
- **A TOTP code is claimed before it is checked**, in `auth_totp_claims`, keyed on the user and an
  HMAC of the code, for the ninety seconds the plugin would accept it. The primary key makes the claim
  atomic. A replay is refused with the plugin's own `INVALID_CODE`, so it cannot be told from a
  wrong code.
- **The session path gets the plugin's own budget**: ten consecutive failures lock the account for
  fifteen minutes, on the plugin's `failed_verification_count` and `locked_until` columns, shared
  with the sign-in path.
- **Every accepted code stamps `auth_sessions.last_verified_at`**. The step-up check reads that row
  by the session's token, in SQL, with the database's clock, and answers booleans — so the cookie
  cache, application clock skew and raw-`execute` timestamp strings are all out of the question. A
  session the table no longer holds is refused, whatever a cached copy says.
- **Re-enrolling, reading out the secret, regenerating codes and disabling are step-up actions** for
  an account that already has a second factor.
- **Every plugin endpoint is classified**, and a test holds the classification to the plugin's real
  endpoint list, so an upgrade that adds a path fails until somebody decides what it is.

The SQL lives in `packages/db/src/auth-db.ts`, the named exception for the auth adapter's un-scoped
connection (P0-45); core supplies the policy numbers. `auth_totp_claims` carries no `tenant_id`, like
every `auth_*` table, because authentication precedes tenant resolution.

## Alternatives rejected

- **Our own TOTP endpoints instead of the plugin's.** The sign-in challenge — the signed
  `two_factor` cookie, the pending verification, session creation after the code — is the plugin's,
  and reimplementing it to own five details would own fifty.
- **Encrypted backup codes, as the plugin ships them.** An encrypted code is a readable code; the row
  says hashed because they are password-equivalent.
- **Claiming a code after it verifies.** By then the plugin has created the session and set its
  cookie; refusing afterwards means unwinding both. Claiming first costs nothing — a wrong code
  claimed is still wrong.
- **`getSession({ disableCookieCache: true })` for step-up.** `getSessionFromCtx` returns whatever
  session is already cached on the request context, so the flag is not something to rest a
  privilege check on. An explicit read by token is.

## Consequences

- Each gap is asserted against the real library in `apps/api/test/mfa.integration.test.ts`. An
  upgrade that renames a path or changes what a hook receives fails there rather than reopening a
  gap quietly.
- The hooks depend on the plugin's internal cookie name (`two_factor`) and on hook context
  semantics. Both are pinned with the library and exercised by that suite.
- The audit row for a change to a second factor is written after Better Auth commits the change, on
  its own transaction, into every winery the user belongs to. It cannot share the change's
  transaction (P0-53's rule), so the order is the safe one and a failed write is logged, not thrown.
- Rotating the auth secret invalidates every backup code, as it already invalidates every TOTP secret
  the plugin encrypted with it.
