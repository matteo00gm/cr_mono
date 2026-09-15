import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from 'jose';

/**
 * The widget session token keys (P2-11, §3.4, §5.7).
 *
 * **Ed25519, signed in process.** KMS asymmetric signing would put a network
 * round trip and a dollar a month per key on every session mint; an Ed25519
 * signature in the Lambda costs neither. The private key lives in a secret
 * (`WidgetTokenKeys`, an SSM `SecureString`) and reaches the function the way
 * `AUTH_SECRET` does, so it is read once per container.
 *
 * **Two keys at most, so a rotation overlaps.** The first key in the set signs;
 * every key in it verifies. Rotating is a new key put first, with its predecessor
 * kept second until every token it signed has expired — fifteen minutes later —
 * and then dropped. A token whose `kid` is no longer in the set fails, which is
 * how a retired key stops being accepted.
 *
 * **On the `./tokens` subpath, never the package barrel.** The dashboard's
 * browser bundle imports `@catalogorosso/security`, and nothing about signing
 * belongs in a page.
 *
 * Nothing here ever puts key material in a message, and the loaded keys cannot
 * be serialised back into it.
 */

/** Pinned: the only algorithm a widget token may carry (§3.4). Never read from the token. */
const ALGORITHM = 'EdDSA';

/** The newest key signs; the one before it still verifies. */
export const MAX_ACTIVE_KEYS = 2;

/** `exp` and `iat` skew a verifier tolerates (P2-13's "≤5 s"). */
export const CLOCK_TOLERANCE_SEC = 5;

/** The keyset cannot be used. The reason names what is wrong, never a key's value. */
export class InvalidWidgetTokenKeysError extends Error {
  constructor(reason: string) {
    super(
      `The widget token keyset is unusable: ${reason}. ` +
        'Generate one with `node scripts/widget-token-key.mjs` (P2-11).',
    );
    this.name = 'InvalidWidgetTokenKeysError';
  }
}

/** A token names no key, or one this set does not hold — a retired key, or none of ours. */
export class UnknownWidgetTokenKeyError extends Error {
  constructor() {
    super('The token was signed with a key this service does not hold.');
    this.name = 'UnknownWidgetTokenKeyError';
  }
}

export interface SignOptions {
  readonly issuer: string;
  readonly audience: string;
  /** Seconds from `now` to `exp`. */
  readonly ttlSec: number;
  readonly now?: Date | undefined;
}

export interface VerifyOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly now?: Date | undefined;
}

export interface VerifiedToken {
  readonly payload: JWTPayload;
  /** Which key verified it, so a caller can see a rotation in progress. */
  readonly kid: string;
}

export interface WidgetTokenKeys {
  /** The key new tokens are signed with. */
  readonly signingKid: string;
  /** Every key a token may be verified with, the signing key first. */
  readonly kids: readonly string[];
  sign(claims: JWTPayload, options: SignOptions): Promise<string>;
  verify(token: string, options: VerifyOptions): Promise<VerifiedToken>;
}

interface Ed25519Jwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly kid: string;
  readonly x: string;
  readonly d: string;
}

type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

interface LoadedKey {
  readonly kid: string;
  readonly signing: ImportedKey;
  readonly verifying: ImportedKey;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One entry of the set, checked field by field; its position is how a message names it. */
const ed25519Jwk = (value: unknown, position: number, seen: Set<string>): Ed25519Jwk => {
  if (!isRecord(value))
    throw new InvalidWidgetTokenKeysError(`key ${String(position)} is not an object`);

  const { kid, kty, crv, x, d } = value;

  if (typeof kid !== 'string' || kid.trim() === '') {
    throw new InvalidWidgetTokenKeysError(`key ${String(position)} has no kid`);
  }
  if (seen.has(kid)) throw new InvalidWidgetTokenKeysError(`the kid "${kid}" appears twice`);
  seen.add(kid);

  if (kty !== 'OKP') throw new InvalidWidgetTokenKeysError(`key "${kid}" is not an OKP key`);
  if (crv !== 'Ed25519') throw new InvalidWidgetTokenKeysError(`key "${kid}" is not Ed25519`);
  if (typeof x !== 'string') {
    throw new InvalidWidgetTokenKeysError(`key "${kid}" has no public half`);
  }
  if (typeof d !== 'string') {
    throw new InvalidWidgetTokenKeysError(`key "${kid}" has no private half, so it cannot sign`);
  }

  return { kty, crv, kid, x, d };
};

/** The set, parsed and checked, as a non-empty list: the first entry signs. */
const parseKeyset = (serialized: string): readonly [Ed25519Jwk, ...Ed25519Jwk[]] => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new InvalidWidgetTokenKeysError('it is not JSON');
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.keys)) {
    throw new InvalidWidgetTokenKeysError('it has no "keys" array');
  }

  const seen = new Set<string>();
  const [first, ...rest] = (parsed.keys as unknown[]).map((key, index) =>
    ed25519Jwk(key, index + 1, seen),
  );

  if (first === undefined) throw new InvalidWidgetTokenKeysError('it holds no keys');

  if (rest.length >= MAX_ACTIVE_KEYS) {
    throw new InvalidWidgetTokenKeysError(
      `it holds ${String(rest.length + 1)} keys, and at most ${String(MAX_ACTIVE_KEYS)} may be ` +
        'active — the newest, which signs, and the one before it',
    );
  }

  return [first, ...rest];
};

/**
 * Imports one key: the whole private JWK to sign, and only its public half to
 * verify, so verification never holds private material.
 *
 * **A private half beside the wrong public half is refused here**, and by the
 * platform rather than by this code: WebCrypto checks that `x` belongs to `d`
 * when it imports an Ed25519 private key. That pair would otherwise mint tokens
 * nothing can verify — every session mint succeeding and every widget call
 * after it failing — so the test suite pins the refusal, and a runtime that ever
 * stopped checking fails there rather than in production.
 */
const loadKey = async (jwk: Ed25519Jwk): Promise<LoadedKey> => {
  try {
    return {
      kid: jwk.kid,
      signing: await importJWK(jwk, ALGORITHM),
      verifying: await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, ALGORITHM),
    };
  } catch {
    throw new InvalidWidgetTokenKeysError(`key "${jwk.kid}" could not be imported as Ed25519`);
  }
};

/** The `kid` a token names, or a refusal: a token without one cannot be matched to a key. */
const kidOf = (header: { readonly kid?: string | undefined }): string => {
  if (header.kid === undefined || header.kid === '') throw new UnknownWidgetTokenKeyError();
  return header.kid;
};

/**
 * Loads a serialised keyset — `{ "keys": [<Ed25519 private JWK>, …] }`, one or
 * two entries, the first signing.
 *
 * Throws `InvalidWidgetTokenKeysError` for anything it cannot use, so a bad
 * secret stops the container starting rather than failing each mint.
 */
export const loadWidgetTokenKeys = async (serialized: string): Promise<WidgetTokenKeys> => {
  const [first, ...rest] = parseKeyset(serialized);
  const signer = await loadKey(first);
  const others = await Promise.all(rest.map(loadKey));

  const verifyingKeys = new Map([signer, ...others].map((key) => [key.kid, key.verifying]));

  const keyFor = (header: { readonly kid?: string | undefined }): ImportedKey => {
    const key = verifyingKeys.get(kidOf(header));
    if (key === undefined) throw new UnknownWidgetTokenKeyError();
    return key;
  };

  const keys: WidgetTokenKeys = {
    signingKid: signer.kid,
    kids: [signer.kid, ...others.map((key) => key.kid)],

    sign: (claims, { issuer, audience, ttlSec, now = new Date() }) => {
      if (!Number.isInteger(ttlSec) || ttlSec <= 0) {
        return Promise.reject(
          new RangeError(`ttlSec must be a positive whole number, not ${String(ttlSec)}`),
        );
      }

      const issuedAt = Math.floor(now.getTime() / 1000);

      return new SignJWT(claims)
        .setProtectedHeader({ alg: ALGORITHM, kid: signer.kid, typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttlSec)
        .sign(signer.signing);
    },

    verify: async (token, { issuer, audience, now }) => {
      const { payload, protectedHeader } = await jwtVerify(token, keyFor, {
        // An allowlist, never inferred from the token: `none` and HS/RS confusion fail here.
        algorithms: [ALGORITHM],
        issuer,
        audience,
        clockTolerance: CLOCK_TOLERANCE_SEC,
        requiredClaims: ['exp', 'iat'],
        ...(now === undefined ? {} : { currentDate: now }),
      });

      return { payload, kid: kidOf(protectedHeader) };
    },
  };

  /*
   * The imported keys are closed over, not held as properties, so neither
   * `JSON.stringify` nor a logger walking this object can reach them.
   */
  return Object.freeze(keys);
};

/**
 * A new Ed25519 private JWK, for the out-of-band generator
 * (`scripts/widget-token-key.mjs`). Never called by a running service.
 */
export const generateWidgetTokenKey = async (kid: string): Promise<JWK> => {
  const { privateKey } = await generateKeyPair(ALGORITHM, { crv: 'Ed25519', extractable: true });
  return { ...(await exportJWK(privateKey)), kid };
};
