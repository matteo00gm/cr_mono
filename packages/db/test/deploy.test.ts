import { describe, expect, it } from 'vitest';

import { withRole } from '../src/deploy.js';

/**
 * `withRole` is the one piece of the deploy path with logic worth pinning
 * without Docker. Getting it wrong does not fail loudly: a URL that keeps the
 * master credentials would run migrations as a superuser, which succeeds and
 * leaves every table owned by the wrong role.
 */
describe('withRole', () => {
  const MASTER = 'postgres://master:secret@db.internal:5432/sommelier?sslmode=require';

  it('swaps the role and password while keeping host, port and database', () => {
    const url = new URL(withRole(MASTER, 'app_migrate', 'pw'));

    expect(url.username).toBe('app_migrate');
    expect(url.hostname).toBe('db.internal');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/sommelier');
  });

  it('keeps the query string, so sslmode is not silently dropped', () => {
    expect(withRole(MASTER, 'app_migrate', 'pw')).toContain('sslmode=require');
  });

  it('leaves no trace of the credentials it replaced', () => {
    const result = withRole(MASTER, 'app_migrate', 'pw');

    expect(result).not.toContain('master');
    expect(result).not.toContain('secret');
  });

  it('encodes a password containing URL-reserved characters', () => {
    // The failure this prevents: an unencoded `@` ends the userinfo section, so
    // the rest of the password becomes the host and the deploy connects
    // somewhere else entirely — or, worse, somewhere that exists.
    const url = new URL(withRole(MASTER, 'app_migrate', 'p@ss/w:rd?x'));

    expect(url.hostname).toBe('db.internal');
    expect(decodeURIComponent(url.password)).toBe('p@ss/w:rd?x');
  });
});
