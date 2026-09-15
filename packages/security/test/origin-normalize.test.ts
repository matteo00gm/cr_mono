import { describe, expect, it } from 'vitest';

import { normalizeOrigin, type NormalizeFailure } from '../src/origin/normalize.js';

/**
 * Origin normalisation (P2-05).
 *
 * One case per decision the function makes, so every branch is proven to fire.
 * P2-06 extends this file with the exhaustive table and the bypass strings.
 */

const accepted = (input: string, environment?: 'production' | 'development') => {
  const result = normalizeOrigin(input, environment === undefined ? {} : { environment });
  if (!result.ok)
    throw new Error(`expected ${JSON.stringify(input)} to be accepted, got ${result.reason}`);
  return result;
};

const refusal = (
  input: string,
  environment?: 'production' | 'development',
): NormalizeFailure | 'accepted' => {
  const result = normalizeOrigin(input, environment === undefined ? {} : { environment });
  return result.ok ? 'accepted' : result.reason;
};

describe('normalizeOrigin — what it returns', () => {
  it('prepends https to a bare domain and serialises without a trailing slash', () => {
    expect(accepted('winery.com')).toEqual({
      ok: true,
      origin: 'https://winery.com',
      registrableDomain: 'winery.com',
    });
  });

  it('lowercases, drops the default port and a trailing slash', () => {
    expect(accepted('  HTTPS://WWW.WINERY.COM:443/ ').origin).toBe('https://www.winery.com');
  });

  it('keeps a port that is not the default', () => {
    expect(accepted('winery.com:8443').origin).toBe('https://winery.com:8443');
  });

  it('reduces a subdomain to its registrable domain', () => {
    expect(accepted('https://shop.winery.co.uk')).toMatchObject({
      origin: 'https://shop.winery.co.uk',
      registrableDomain: 'winery.co.uk',
    });
  });

  it('treats a single trailing dot as the same name', () => {
    expect(accepted('winery.com.').origin).toBe('https://winery.com');
  });

  it('counts a private suffix, so one shop is not the whole platform', () => {
    expect(accepted('shop.myshopify.com').registrableDomain).toBe('shop.myshopify.com');
    expect(refusal('myshopify.com')).toBe('public_suffix');
  });
});

describe('normalizeOrigin — what it refuses, and why', () => {
  it.each<[string, NormalizeFailure]>([
    ['', 'invalid_url'],
    ['   ', 'invalid_url'],
    ['javascript:alert(1)', 'invalid_url'],
    ['https://user@winery.com', 'invalid_url'],
    ['https://user:secret@winery.com', 'invalid_url'],
    ['https://:secret@winery.com', 'invalid_url'],
    ['win_ery.com', 'invalid_url'],
    ['*.winery.com', 'invalid_url'],
    ['winery.com..', 'invalid_url'],
    [`${'a'.repeat(64)}.com`, 'invalid_url'],
    [`${'a.'.repeat(126)}com`, 'invalid_url'],
    ['http://winery.com', 'not_https'],
    ['ftp://winery.com', 'not_https'],
    ['winery.com/shop', 'has_path'],
    ['winery.com?', 'has_path'],
    ['winery.com?q=1', 'has_path'],
    ['winery.com#top', 'has_path'],
    ['192.168.1.1', 'ip_literal'],
    ['0x7f.1', 'ip_literal'],
    ['[::1]', 'ip_literal'],
    ['localhost', 'localhost'],
    ['shop.localhost', 'localhost'],
    ['com', 'public_suffix'],
    ['co.uk', 'public_suffix'],
    ['winery', 'single_label'],
  ])('refuses %j as %s', (input, reason) => {
    expect(refusal(input)).toBe(reason);
  });
});

describe('normalizeOrigin — development', () => {
  it('admits http and localhost, keeping the port', () => {
    expect(accepted('http://localhost:5173', 'development')).toEqual({
      ok: true,
      origin: 'http://localhost:5173',
      registrableDomain: 'localhost',
    });
    expect(accepted('http://winery.com', 'development').origin).toBe('http://winery.com');
  });

  it('still refuses what development has no reason to accept', () => {
    expect(refusal('192.168.1.1', 'development')).toBe('ip_literal');
    expect(refusal('ftp://winery.com', 'development')).toBe('not_https');
  });

  it('is strict when nothing is said', () => {
    expect(refusal('http://localhost:5173')).toBe('not_https');
    expect(refusal('http://localhost:5173', 'production')).toBe('not_https');
  });
});

/*
 * ---- P2-06: the exhaustive table ------------------------------------------
 *
 * The row's cases, verbatim, then the bypass strings. A bypass only matters
 * against P2-08's comparison, which is exact string equality with a verified
 * origin — so each one is asserted to be refused or to normalise to something
 * that is not that origin. "Handled" is not an outcome.
 */

const VERIFIED = 'https://winery.com';

describe('the table (P2-06)', () => {
  it.each<[string, string]>([
    ['winery.com', 'https://winery.com'],
    ['HTTPS://WINERY.COM/', 'https://winery.com'],
    ['www.winery.com', 'https://www.winery.com'],
    ['winería.com', 'https://xn--winera-7va.com'],
    ['winery.co.uk', 'https://winery.co.uk'],
    ['shop.winery.com', 'https://shop.winery.com'],
    ['winery.com:8443', 'https://winery.com:8443'],
  ])('accepts %j as %s', (input, origin) => {
    expect(accepted(input).origin).toBe(origin);
  });

  it.each<[string, NormalizeFailure]>([
    ['com', 'public_suffix'],
    ['co.uk', 'public_suffix'],
    ['localhost', 'localhost'],
    ['192.168.1.1', 'ip_literal'],
    ['[::1]', 'ip_literal'],
    ['winery', 'single_label'],
    ['winery.com/shop', 'has_path'],
    ['http://winery.com', 'not_https'],
    ['', 'invalid_url'],
    [' \t\n', 'invalid_url'],
    ['javascript:alert(1)', 'invalid_url'],
  ])('refuses %j as %s', (input, reason) => {
    expect(refusal(input)).toBe(reason);
  });

  it('keeps a non-default port as part of the origin, deliberately', () => {
    // A different origin to a browser; collapsing the two would let one stand in
    // for the other.
    expect(accepted('winery.com:8443').origin).not.toBe(VERIFIED);
  });
});

describe('bypass attempts against the verified origin (P2-06)', () => {
  /** What P2-08 would compare: the normalised origin, or nothing at all. */
  const standsInFor = (input: string, origin = VERIFIED): boolean => {
    const result = normalizeOrigin(input);
    return result.ok && result.origin === origin;
  };

  it.each([
    'evil-winery.com',
    'winery.com.attacker.io',
    'WINERY.COM.attacker.io',
    'winery.com.evil.io',
    'wínery.com',
    'xn--winery.com',
    'winery.com%00.evil.io',
    'winery.com%2eevil.io',
    'winery.com@evil.io',
    'https://winery.com@evil.io',
    'https://evil.io#@winery.com',
    'https://evil.io?.winery.com',
    'https://winery.com:443.evil.io',
    'https://winery.com/.evil.io',
    'winery.com\\@evil.io',
    '*.winery.com',
    'https://*.winery.com',
    'wwinery.com',
    'winery.comm',
    'winery.co',
  ])('%j does not stand in for https://winery.com', (input) => {
    expect(standsInFor(input)).toBe(false);
  });

  it('refuses the shapes that are not names at all, rather than rewriting them', () => {
    expect(refusal('winery.com%00.evil.io')).toBe('invalid_url');
    expect(refusal('winery.com@evil.io')).toBe('invalid_url');
    expect(refusal('https://winery.com:443.evil.io')).toBe('invalid_url');
    expect(refusal('*.winery.com')).toBe('invalid_url');
    expect(refusal('https://evil.io#@winery.com')).toBe('has_path');
  });

  it('turns a homoglyph into a different punycode name, not the one it imitates', () => {
    expect(accepted('wínery.com').origin).toBe('https://xn--wnery-zsa.com');
  });

  it('keeps a trailing dot stable either way, and only as the same name', () => {
    expect(accepted('winery.com.').origin).toBe(VERIFIED);
    expect(accepted(accepted('winery.com.').origin).origin).toBe(VERIFIED);
    expect(refusal('winery.com..')).toBe('invalid_url');
  });

  it('is idempotent, so a stored origin normalises to itself', () => {
    for (const input of [
      'winery.com',
      'HTTPS://WWW.WINERY.COM:8443/',
      'winería.com',
      'shop.winery.co.uk.',
    ]) {
      const once = accepted(input).origin;
      expect(accepted(once).origin).toBe(once);
    }
  });

  it('lets only spellings of the one name reach the verified origin', () => {
    /*
     * The inverse of the list above, and the half a refusal-only suite cannot
     * see: a normaliser that let an attacker's string collapse onto a verified
     * origin would pass every refusal and fail here.
     */
    for (const spelling of [
      'winery.com',
      'WINERY.COM',
      'https://winery.com/',
      'https://winery.com:443',
      'winery.com.',
      ' winery.com ',
    ]) {
      expect(standsInFor(spelling)).toBe(true);
    }
  });
});
