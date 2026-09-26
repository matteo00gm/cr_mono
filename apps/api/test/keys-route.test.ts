import { ConflictError, NotFoundError } from '@catalogorosso/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { IssuedKeys, KeysPort, KeysView } from '../src/keys.js';
import { logger } from '../src/middleware/logger.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The keys routes (P4-09).
 *
 * **Two properties here that the port cannot assert.** A response carrying a
 * secret must not be cacheable — by a proxy, a CDN, or the browser's own back
 * button — because a cached secret is a stored secret, somewhere we cannot
 * reach to delete. And nothing the request passes through may log it, which
 * is asserted by capturing every level of the process logger while a secret is
 * issued and searching what it was handed.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

/** Built at runtime, never written into this file (P0-56). */
const SECRET = ['sk', 'live', 'R'.repeat(39) + 'LAST'].join('_');

const viewed: KeysView = {
  publicKey: 'pk_live_stored',
  secretKeyPrefix: 'sk_live_RRRR',
  secretKeyLast4: 'LAST',
  createdAt: '2026-09-26T09:00:00.000Z',
  updatedAt: '2026-09-26T09:00:00.000Z',
};

const issued: IssuedKeys = { ...viewed, secretKey: SECRET };

const calls: string[] = [];

const port = (overrides: Partial<KeysPort> = {}): KeysPort => ({
  read: (tenantId) => {
    calls.push(`read(${tenantId})`);

    return Promise.resolve(viewed);
  },
  create: (tenantId) => {
    calls.push(`create(${tenantId})`);

    return Promise.resolve(issued);
  },
  rotateSecret: (tenantId) => {
    calls.push(`rotateSecret(${tenantId})`);

    return Promise.resolve(issued);
  },
  ...overrides,
});

const app = (role: 'OWNER' | 'EDITOR' = 'OWNER', keys: KeysPort = port()) =>
  createApp({ auth: signedIn(), readMemberships: oneMembership(TENANT, role), keys });

const send = (built: ReturnType<typeof createApp>, method: string, path: string) =>
  built.request(`/v1/dashboard${path}`, { method });

afterEach(() => {
  vi.restoreAllMocks();
  calls.length = 0;
});

describe('issuing keys', () => {
  it('answers 201 with the secret, this once', async () => {
    const response = await send(app(), 'POST', '/keys');

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ secretKey: SECRET });
  });

  it('forbids every cache from keeping the response', async () => {
    /*
     * **A cached secret is a stored secret.** `no-store` rather than
     * `no-cache`: the second still lets a cache keep a copy and revalidate it,
     * which for this response is exactly the thing to prevent.
     */
    const response = await send(app(), 'POST', '/keys');

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('takes the tenant from the membership', async () => {
    await send(app(), 'POST', '/keys');

    expect(calls).toEqual([`create(${TENANT})`]);
  });

  it('answers 409 when the winery already has keys', async () => {
    const response = await send(
      app('OWNER', port({ create: () => Promise.reject(new ConflictError('rotate instead')) })),
      'POST',
      '/keys',
    );

    expect(response.status).toBe(409);
  });
});

describe('rotating the secret', () => {
  it('answers 200 with the new secret, uncacheable', async () => {
    const response = await send(app(), 'POST', '/keys/secret/rotate');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ secretKey: SECRET });
  });

  it('answers 404 before any keys exist', async () => {
    const response = await send(
      app('OWNER', port({ rotateSecret: () => Promise.reject(new NotFoundError('none yet')) })),
      'POST',
      '/keys/secret/rotate',
    );

    expect(response.status).toBe(404);
  });
});

describe('reading the keys', () => {
  it('answers with the public key and a hint, never the secret', async () => {
    const response = await send(app(), 'GET', '/keys');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('secretKey');
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('is uncacheable too, so the rule has no exception in it', async () => {
    /* A header that is right on some responses of a path and missing on
     * others is a header somebody forgets on the next route added here. */
    const response = await send(app(), 'GET', '/keys');

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('is uncacheable on a refusal as well', async () => {
    const response = await send(
      app('OWNER', port({ read: () => Promise.reject(new NotFoundError('none yet')) })),
      'GET',
      '/keys',
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('who may touch them', () => {
  it.each([
    ['GET', '/keys'],
    ['POST', '/keys'],
    ['POST', '/keys/secret/rotate'],
  ])('%s %s is closed to an EDITOR', async (method, path) => {
    /* The secret key is what lets a server mint sessions on the winery's
     * behalf (P4-10). That is closer to a password than to a setting. */
    const response = await send(app('EDITOR'), method, path);

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('the logs, while a secret is issued', () => {
  it('never see the secret key, at any level', async () => {
    /*
     * Every level of the process logger, spied, while both secret-bearing
     * routes run — including a failing one, because an error path is where a
     * response body most often ends up in a log line.
     */
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    const spies = levels.map((level) => vi.spyOn(logger, level));

    await send(app(), 'POST', '/keys');
    await send(app(), 'POST', '/keys/secret/rotate');
    await send(
      app('OWNER', port({ create: () => Promise.reject(new Error(`broke holding ${SECRET}`)) })),
      'POST',
      '/keys',
    );

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

    /* The error path did log something, so this is not vacuously clean. */
    expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
    expect(logged).not.toContain(SECRET);
  });

  it('keep a thrown secret out of the response too', async () => {
    /* P0-55: a non-DomainError's message never reaches the caller. Here the
     * message would carry the secret itself. */
    const response = await send(
      app('OWNER', port({ create: () => Promise.reject(new Error(`broke holding ${SECRET}`)) })),
      'POST',
      '/keys',
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(SECRET);
  });
});
