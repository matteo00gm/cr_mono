import { beforeEach, describe, expect, it } from 'vitest';

import type { DevModeResponse } from '@catalogorosso/api-client';

import { createApp } from '../src/app.js';
import type { DomainsPort } from '../src/domains.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * `GET`, `PUT` and `DELETE /v1/dashboard/widget/dev-mode` (P4-19b): who may
 * call them, and that the tenant is the membership's. Enabling needs a fresh
 * second factor, which `step-up.test.ts` asserts off the router.
 */

const AT = new Date('2026-10-01T09:00:00.000Z');

describe('the routes', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const seen: string[] = [];
  const on: DevModeResponse = {
    active: true,
    origin: 'http://localhost:3000',
    expiresAt: AT.toISOString(),
  };
  const unused = () => Promise.reject(new Error('not under test'));
  const domains: DomainsPort = {
    add: unused,
    verify: unused,
    remove: unused,
    claim: unused,
    verifyClaim: unused,
    servedClaims: unused,
    withdrawClaim: unused,
    devMode: (tenantId) => {
      seen.push(`read:${tenantId}`);

      return Promise.resolve(on);
    },
    enableDevMode: (command) => {
      seen.push(`enable:${command.tenantId}:${command.input}`);

      return Promise.resolve(on);
    },
    endDevMode: (tenantId) => {
      seen.push(`end:${tenantId}`);

      return Promise.resolve({ active: false, origin: null, expiresAt: null });
    },
  };

  const app = (role: 'OWNER' | 'EDITOR') =>
    createApp({ auth: signedIn(), readMemberships: oneMembership(TENANT, role), domains });

  const send = (built: ReturnType<typeof app>, method: string, body?: unknown) =>
    built.request('/v1/dashboard/widget/dev-mode', {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeEach(() => {
    seen.length = 0;
  });

  it('reads, grants and ends for the membership’s winery', async () => {
    expect((await send(app('OWNER'), 'GET')).status).toBe(200);
    expect((await send(app('OWNER'), 'PUT', { origin: 'localhost:3000' })).status).toBe(200);
    expect((await send(app('OWNER'), 'DELETE')).status).toBe(200);
    expect(seen).toEqual([`read:${TENANT}`, `enable:${TENANT}:localhost:3000`, `end:${TENANT}`]);
  });

  it.each([{}, { origin: '' }, { origin: 'localhost:3000', tenantId: 'x' }])(
    'refuses %j without troubling the port',
    async (body) => {
      expect((await send(app('OWNER'), 'PUT', body)).status).toBe(422);
      expect(seen).toEqual([]);
    },
  );

  it.each(['GET', 'PUT', 'DELETE'])('%s is an owner’s', async (method) => {
    const response = await send(
      app('EDITOR'),
      method,
      method === 'PUT' ? { origin: 'localhost:3000' } : undefined,
    );

    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });
});
