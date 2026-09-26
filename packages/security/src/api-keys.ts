import { createHash, randomBytes } from 'node:crypto';

/**
 * The keys a seller integrates with (P4-09, ADR 0025).
 *
 * `pk_live_` is public by construction — it ships in a script tag on the
 * seller's own page, and what protects it is the origin allowlist (§3.2). The
 * `sk_live_` key is the opposite: it authenticates a server-to-server session
 * mint (P4-10), and it must never be recoverable from anything we store.
 *
 * **It is hashed with SHA-256, not a slow KDF, and ADR 0025 records why.** A
 * slow KDF protects a *low-entropy* secret — a password somebody chose — by
 * making each guess expensive. This key is 256 bits from the CSPRNG that
 * nobody chose, so there is no guess cheaper than any other and a leaked
 * SHA-256 of it is exactly as irreversible as a leaked argon2id. What a slow
 * KDF *would* change is the cost of verifying — on an endpoint anybody on the
 * internet can call.
 *
 * **Which makes the generator the whole of the security argument.** The
 * moment a key had less entropy, the hash choice would quietly become wrong.
 * The tests assert the length and the alphabet directly for that reason.
 */

export const SECRET_KEY_PREFIX = 'sk_live_';
export const PUBLIC_KEY_PREFIX = 'pk_live_';

/**
 * Base62, so a key survives being pasted anywhere — a URL, a shell, an `.env`
 * file, a YAML value — without quoting. It is also exactly the alphabet the log
 * redaction's key pattern matches (`[A-Za-z0-9]`), and that is not a
 * coincidence to leave to chance: a character outside it would end the match
 * early and log the rest of the key in the clear.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * 43 base62 characters carry 43 × log₂62 ≈ 256.03 bits: the "32 random bytes"
 * the row specifies, without a bigint conversion to get there.
 */
export const KEY_BODY_LENGTH = 43;

/**
 * The largest multiple of 62 that fits in a byte. A byte at or above it is
 * thrown away rather than folded in with `%`, because `% 62` on the full 0–255
 * range makes the first eight characters of the alphabet slightly likelier
 * than the rest — a bias, and in a secret a bias is lost entropy.
 */
const UNBIASED_CEILING = 248;

/** Random characters from the alphabet, by rejection sampling. */
const randomBody = (length: number): string => {
  let body = '';

  while (body.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < UNBIASED_CEILING) body += ALPHABET.charAt(byte % ALPHABET.length);
      if (body.length === length) break;
    }
  }

  return body;
};

export const newSecretKey = (): string => `${SECRET_KEY_PREFIX}${randomBody(KEY_BODY_LENGTH)}`;

/**
 * A public key. Long for a value that is not secret, and deliberately: it is
 * unique across every tenant, and a key that could be guessed is a key that
 * could be *targeted* — somebody scanning for live keys to present from origins
 * they control, to be refused and recorded (P2-16) but to cost us a lookup.
 */
export const newPublicKey = (): string => `${PUBLIC_KEY_PREFIX}${randomBody(24)}`;

/**
 * What is stored in place of the key: hex SHA-256 of the whole thing.
 *
 * Deterministic on purpose, so P4-10 finds a presented key with one indexed
 * equality lookup rather than having to know which row to verify it against.
 */
export const hashSecretKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

/**
 * Enough to recognise a key on the dashboard, not enough to use it.
 *
 * `sk_live_` and four characters, plus the last four — 48 bits of a 256-bit
 * body disclosed, which is what "which of my keys is this?" costs and leaves
 * 208 bits nobody can guess.
 */
export const secretKeyHint = (
  key: string,
): { readonly prefix: string; readonly last4: string } => ({
  prefix: key.slice(0, SECRET_KEY_PREFIX.length + 4),
  last4: key.slice(-4),
});

/**
 * Whether a string has the shape of one of our secret keys.
 *
 * A shape check, not a verification: it is what lets P4-10 refuse a `pk_` sent
 * as a secret without hashing anything, and what keeps a malformed header from
 * costing a database read.
 */
export const looksLikeSecretKey = (value: string): boolean =>
  new RegExp(`^${SECRET_KEY_PREFIX}[0-9A-Za-z]{${String(KEY_BODY_LENGTH)}}$`, 'u').test(value);
