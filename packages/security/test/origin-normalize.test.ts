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
