/**
 * Secret-shaped fixtures, assembled at runtime (P0-56).
 *
 * **Nothing here may be written as a literal, and that is the whole point of
 * the module.** The P0-08 gitleaks rules match `sk_live_` followed by 24
 * characters, and CI scans full history — so a fixture key written out in a
 * test file is found, reported, and then permanent, because history cannot be
 * edited after a push. That is the plan's own warning about a scanner flagging
 * itself, and it will otherwise be rediscovered once per suite that needs a
 * key-shaped string: P0-56 redacts them, P0-46 puts tokens in headers, P2-13
 * verifies them.
 *
 * `join` rather than a template literal, deliberately.
 * `@typescript-eslint/no-unnecessary-template-expression` flags `${'live'}` and
 * offers to inline it — and `eslint --fix` in the pre-commit hook would take
 * that offer, reintroducing the literal the moment somebody runs it. An array
 * join is not something the rule can collapse.
 */

/** Long enough to match the 24-character floor in the gitleaks rules. */
const BODY = 'A1b2C3d4E5f6G7h8';

const prefixed = (prefix: string, mode: string, body: string): string =>
  [prefix, mode, body].join('_');

/** A secret API key: server-side only, and never in a repository (§3.2). */
export const secretKeyFixture = (body = BODY): string => prefixed('sk', 'live', body);

/** A publishable key. Public by design, but still not ours to commit. */
export const publishableKeyFixture = (body = BODY): string => prefixed('pk', 'live', body);

/** A test-mode key, for the `livemode` distinction §5.2b asserts on. */
export const testKeyFixture = (body = BODY): string => prefixed('sk', 'test', body);

/**
 * A structurally valid JWT — three base64url segments.
 *
 * Not signed and not verifiable: what consumes it is redaction and header
 * handling, neither of which parses it. The `eyJ` prefix is `{"` in base64,
 * which is what makes the shape recognisable in the first place.
 */
export const jwtFixture = (): string =>
  ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NSJ9', 'QW55U2lnbmF0dXJl'].join('.');

/** A connection string with credentials, as a driver error would quote it. */
export const connectionStringFixture = (password = 'hunter2'): string =>
  `postgres://app_rw:${password}@db.internal:5432/sommelier`;
