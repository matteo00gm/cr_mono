import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { importJWK, SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { redactLogObject, serialiseError } from '../src/redact.js';
import {
  CLOCK_TOLERANCE_SEC,
  generateWidgetTokenKey,
  InvalidWidgetTokenKeysError,
  loadWidgetTokenKeys,
  MAX_ACTIVE_KEYS,
  UnknownWidgetTokenKeyError,
} from '../src/tokens/keys.js';

/**
 * The widget session token keys (P2-11).
 *
 * The row's three assertions — a round trip, a key verifying only while it is
 * in the set, and the key never reaching a log — plus what makes a keyset safe
 * to load: every way a secret can be malformed is refused at load, with a
 * message that names the problem and never the value.
 */

const ISSUER = 'https://api.catalogorosso.test';
const AUDIENCE = 'widget';
const OPTIONS = { issuer: ISSUER, audience: AUDIENCE, ttlSec: 900 } as const;

/** Typed loosely on purpose: half of these cases are keysets no JWK type would allow. */
const keysetOf = (...keys: unknown[]): string => JSON.stringify({ keys });

const loadFresh = async (...kids: string[]) =>
  loadWidgetTokenKeys(keysetOf(...(await Promise.all(kids.map(generateWidgetTokenKey)))));

/** Awaits a rejection and hands back the error, so its message can be inspected. */
const failureOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected a rejection');
};

describe('a round trip', () => {
  it('signs with EdDSA and the key id, and verifies what it signed', async () => {
    const keys = await loadFresh('k1');

    const token = await keys.sign({ tid: 'tenant-1', sid: 'session-1' }, OPTIONS);
    const [header] = token.split('.');
    const verified = await keys.verify(token, { issuer: ISSUER, audience: AUDIENCE });

    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'EdDSA',
      kid: 'k1',
      typ: 'JWT',
    });
    expect(verified.kid).toBe('k1');
    expect(verified.payload).toMatchObject({
      tid: 'tenant-1',
      sid: 'session-1',
      iss: ISSUER,
      aud: AUDIENCE,
    });
    expect((verified.payload.exp ?? 0) - (verified.payload.iat ?? 0)).toBe(900);
  });

  it('sets iat and exp from the clock it is given', async () => {
    const keys = await loadFresh('k1');
    const now = new Date('2026-09-15T10:00:00Z');

    const token = await keys.sign({}, { ...OPTIONS, now });
    const { payload } = await keys.verify(token, { issuer: ISSUER, audience: AUDIENCE, now });

    expect(payload.iat).toBe(now.getTime() / 1000);
    expect(payload.exp).toBe(now.getTime() / 1000 + 900);
  });

  it('refuses a lifetime that is not a positive whole number of seconds', async () => {
    const keys = await loadFresh('k1');

    for (const ttlSec of [0, -60, 1.5]) {
      await expect(keys.sign({}, { ...OPTIONS, ttlSec })).rejects.toThrow(RangeError);
    }
  });
});

describe('rotation', () => {
  it('signs with the first key and verifies with every key in the set', async () => {
    const [older, newer] = await Promise.all([
      generateWidgetTokenKey('k1'),
      generateWidgetTokenKey('k2'),
    ]);
    const before = await loadWidgetTokenKeys(keysetOf(older));
    const during = await loadWidgetTokenKeys(keysetOf(newer, older));

    const oldToken = await before.sign({}, OPTIONS);

    expect(during.signingKid).toBe('k2');
    expect(during.kids).toEqual(['k2', 'k1']);
    expect((await during.verify(oldToken, { issuer: ISSUER, audience: AUDIENCE })).kid).toBe('k1');
    expect((await during.verify(await during.sign({}, OPTIONS), OPTIONS)).kid).toBe('k2');
  });

  it('refuses a token once its key has left the set', async () => {
    const [older, newer] = await Promise.all([
      generateWidgetTokenKey('k1'),
      generateWidgetTokenKey('k2'),
    ]);
    const oldToken = await (await loadWidgetTokenKeys(keysetOf(older))).sign({}, OPTIONS);
    const after = await loadWidgetTokenKeys(keysetOf(newer));

    await expect(after.verify(oldToken, OPTIONS)).rejects.toThrow(UnknownWidgetTokenKeyError);
  });

  it('refuses a token signed by a key with the right id and the wrong material', async () => {
    const impostor = await loadFresh('k1');
    const keys = await loadFresh('k1');

    await expect(keys.verify(await impostor.sign({}, OPTIONS), OPTIONS)).rejects.toThrow();
  });
});

describe('what a verifier refuses', () => {
  it('a token naming no key', async () => {
    const keys = await loadFresh('k1');
    const signer = await loadFresh('k1');
    const withKid = await signer.sign({}, OPTIONS);
    const [, payload, signature] = withKid.split('.');
    const noKid = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');

    await expect(
      keys.verify(`${noKid}.${payload ?? ''}.${signature ?? ''}`, OPTIONS),
    ).rejects.toThrow(UnknownWidgetTokenKeyError);
  });

  it('an empty key id', async () => {
    const keys = await loadFresh('k1');
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: '' })).toString('base64url');

    await expect(keys.verify(`${header}.e30.c2ln`, OPTIONS)).rejects.toThrow(
      UnknownWidgetTokenKeyError,
    );
  });

  it('alg: none, whatever the key id says', async () => {
    const keys = await loadFresh('k1');
    const unsigned = new UnsecuredJWT({ iss: ISSUER, aud: AUDIENCE })
      .setIssuedAt()
      .setExpirationTime('15m')
      .encode();
    const [, payload] = unsigned.split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');

    await expect(keys.verify(`${header}.${payload ?? ''}.`, OPTIONS)).rejects.toThrow();
  });

  it('HS256 signed with a secret, however it names the key', async () => {
    const keys = await loadFresh('k1');
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('the public key used as an HMAC secret'));

    const failure = await failureOf(keys.verify(forged, OPTIONS));

    expect(failure.name).toBe('JOSEAlgNotAllowed');
  });

  it('another issuer, another audience, and an expired token', async () => {
    const keys = await loadFresh('k1');
    const now = new Date('2026-09-15T10:00:00Z');
    const token = await keys.sign({}, { ...OPTIONS, now, ttlSec: 60 });

    await expect(
      keys.verify(token, { ...OPTIONS, issuer: 'https://evil.test', now }),
    ).rejects.toThrow();
    await expect(keys.verify(token, { ...OPTIONS, audience: 'dashboard', now })).rejects.toThrow();

    const pastTolerance = new Date(now.getTime() + (60 + CLOCK_TOLERANCE_SEC + 1) * 1000);
    const withinTolerance = new Date(now.getTime() + (60 + CLOCK_TOLERANCE_SEC - 1) * 1000);

    await expect(keys.verify(token, { ...OPTIONS, now: pastTolerance })).rejects.toThrow();
    await expect(keys.verify(token, { ...OPTIONS, now: withinTolerance })).resolves.toMatchObject({
      kid: 'k1',
    });
  });

  it('an expired token, unless a continuation window was asked for and has not closed (P2-12a)', async () => {
    const keys = await loadFresh('k1');
    const minted = new Date('2026-09-15T10:00:00Z');
    const token = await keys.sign({}, { ...OPTIONS, now: minted, ttlSec: 60 });
    const lapsed = (seconds: number) => new Date(minted.getTime() + (60 + seconds) * 1000);
    const within = (seconds: number, expiredWithinSec: number) =>
      keys.verify(token, { ...OPTIONS, now: lapsed(seconds), expiredWithinSec });

    await expect(keys.verify(token, { ...OPTIONS, now: lapsed(600) })).rejects.toThrow();
    await expect(within(600, 1800)).resolves.toMatchObject({ kid: 'k1' });
    await expect(within(1799, 1800)).resolves.toMatchObject({ kid: 'k1' });
    await expect(within(1800, 1800)).rejects.toThrow();

    // A window narrower than the skew does not take the skew away.
    await expect(within(CLOCK_TOLERANCE_SEC - 1, 1)).resolves.toMatchObject({ kid: 'k1' });
  });

  it('a continuation window that is not a whole number of seconds', async () => {
    const keys = await loadFresh('k1');
    const token = await keys.sign({}, OPTIONS);

    for (const expiredWithinSec of [-1, 1.5, Number.NaN]) {
      await expect(keys.verify(token, { ...OPTIONS, expiredWithinSec })).rejects.toThrow(
        RangeError,
      );
    }
  });

  it('a token with no expiry, or no issue time', async () => {
    // Signed with the set's own key, so the only thing wrong is the missing claim.
    const jwk = await generateWidgetTokenKey('k1');
    const keys = await loadWidgetTokenKeys(keysetOf(jwk));
    const signing = await importJWK(jwk, 'EdDSA');
    const unsigned = () =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE);

    const noExp = await unsigned().setIssuedAt().sign(signing);
    const noIat = await unsigned().setExpirationTime('15m').sign(signing);

    await expect(keys.verify(noExp, OPTIONS)).rejects.toThrow();
    await expect(keys.verify(noIat, OPTIONS)).rejects.toThrow();
  });
});

describe('loading a keyset', () => {
  const valid = () => generateWidgetTokenKey('k1');

  it.each<[string, () => Promise<string>, RegExp]>([
    ['text that is not JSON', () => Promise.resolve('not json'), /not JSON/],
    ['JSON with no keys array', () => Promise.resolve('{"key":{}}'), /no "keys" array/],
    ['an array instead of a set', () => Promise.resolve('[]'), /no "keys" array/],
    ['an empty set', () => Promise.resolve('{"keys":[]}'), /holds no keys/],
    [
      'an entry that is not an object',
      () => Promise.resolve('{"keys":["k1"]}'),
      /key 1 is not an object/,
    ],
    [
      'an entry with no kid',
      async () => keysetOf({ ...(await valid()), kid: ' ' }),
      /key 1 has no kid/,
    ],
    [
      'an entry whose kid is not text',
      async () => keysetOf({ ...(await valid()), kid: 7 }),
      /key 1 has no kid/,
    ],
    [
      'two entries with one kid',
      async () => keysetOf(await valid(), await valid()),
      /"k1" appears twice/,
    ],
    [
      'a key that is not OKP',
      async () => keysetOf({ ...(await valid()), kty: 'EC' }),
      /not an OKP key/,
    ],
    [
      'an OKP key on another curve',
      async () => keysetOf({ ...(await valid()), crv: 'X25519' }),
      /not Ed25519/,
    ],
    [
      'a key with no public half',
      async () => keysetOf({ ...(await valid()), x: undefined }),
      /no public half/,
    ],
    [
      'a public key with no private half',
      async () => keysetOf({ ...(await valid()), d: undefined }),
      /no private half/,
    ],
    [
      'material that is not a key',
      async () => keysetOf({ ...(await valid()), x: 'AAAA', d: 'AAAA' }),
      /could not be imported/,
    ],
  ])('refuses %s', async (_case, serialized, reason) => {
    const failure = await failureOf(loadWidgetTokenKeys(await serialized()));

    expect(failure).toBeInstanceOf(InvalidWidgetTokenKeysError);
    expect(failure.message).toMatch(reason);
  });

  it('refuses more keys than a rotation needs', async () => {
    const three = keysetOf(...(await Promise.all(['k1', 'k2', 'k3'].map(generateWidgetTokenKey))));

    const failure = await failureOf(loadWidgetTokenKeys(three));

    expect(MAX_ACTIVE_KEYS).toBe(2);
    expect(failure.message).toMatch(/3 keys, and at most 2/);
  });

  it('refuses a private half pasted beside another key’s public half', async () => {
    /*
     * The platform's check, pinned. WebCrypto refuses to import an Ed25519
     * private key whose `x` does not belong to its `d`; without that, this pair
     * would sign tokens nothing can verify. If a runtime ever stops checking,
     * this is where it shows.
     */
    const [mine, theirs] = await Promise.all([valid(), generateWidgetTokenKey('k2')]);

    const failure = await failureOf(loadWidgetTokenKeys(keysetOf({ ...mine, x: theirs.x })));

    expect(failure).toBeInstanceOf(InvalidWidgetTokenKeysError);
    expect(failure.message).toMatch(/"k1" could not be imported as Ed25519/);
  });
});

describe('the key never reaches a log', () => {
  const valid = () => generateWidgetTokenKey('k1');

  it('is named by kid in every refusal, and never by value', async () => {
    const [mine, theirs] = await Promise.all([valid(), generateWidgetTokenKey('k2')]);
    const secrets = [mine.d, mine.x, theirs.x].filter((part): part is string => part !== undefined);

    const failure = await failureOf(loadWidgetTokenKeys(keysetOf({ ...mine, x: theirs.x })));
    const logged = JSON.stringify(serialiseError(failure));

    for (const secret of secrets) expect(logged).not.toContain(secret);
  });

  it('cannot be serialised or inspected back out of a loaded set', async () => {
    const jwk = await generateWidgetTokenKey('k1');
    const keys = await loadWidgetTokenKeys(keysetOf(jwk));

    expect(JSON.stringify(keys)).not.toContain(jwk.d ?? 'missing');
    expect(inspect(keys, { depth: 10, showHidden: true })).not.toContain(jwk.d ?? 'missing');
  });

  it('is redacted when a keyset is logged by mistake', async () => {
    const jwk = await generateWidgetTokenKey('k1');
    const serialized = keysetOf(jwk);

    const logged = JSON.stringify(
      redactLogObject({ msg: 'loading keys', keys: serialized, key: jwk, d: jwk.d }),
    );

    expect(logged).not.toContain(jwk.d ?? 'missing');
  });
});

describe('the ./tokens subpath', () => {
  const ROOT = join(import.meta.dirname, '..');

  it('is exported on its own, and never from the barrel a browser bundle imports', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, { default: string }>;
    };
    const barrel = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');

    expect(pkg.exports['./tokens']?.default).toBe('./dist/tokens/keys.js');
    expect(barrel).not.toMatch(/tokens/);
  });
});

describe('generating a key', () => {
  it('produces an Ed25519 private JWK under the kid it is given', async () => {
    const jwk = await generateWidgetTokenKey('wtk-2026-09-15');

    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: 'wtk-2026-09-15' });
    expect(typeof jwk.x).toBe('string');
    expect(typeof jwk.d).toBe('string');
    expect((await loadWidgetTokenKeys(keysetOf(jwk))).signingKid).toBe('wtk-2026-09-15');
  });
});
