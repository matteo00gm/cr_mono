import { ConflictError, NotFoundError } from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { ClaimDomainCommand, VerifyClaimCommand } from '../src/domain-claims.js';
import type { DomainsPort } from '../src/domains.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * `POST /v1/dashboard/domains/claims` and `…/claims/:id/verify` (P4-18).
 *
 * The *surface*: who may call them, what shape a refusal takes, and that the
 * tenant comes from the membership rather than the request (P0-48). What the
 * port does is `domain-claims-port.test.ts`; what the claim scope reaches is
 * `packages/db`'s `with-domain-claim.integration`.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

const claim = {
  id: 'c1',
  origin: 'https://www.winery.com',
  registrableDomain: 'winery.com',
  status: 'PENDING' as const,
  verificationToken: 'a-nonce',
  verificationExpiresAt: '2026-10-06T09:00:00.000Z',
  transferAt: null,
  createdAt: '2026-09-29T09:00:00.000Z',
};

const opened: ClaimDomainCommand[] = [];
const checked: VerifyClaimCommand[] = [];

const unused = () => Promise.reject(new Error('not under test'));

const port = (verifyClaim?: DomainsPort['verifyClaim']): DomainsPort => ({
  add: unused,
  verify: unused,
  remove: unused,
  claim: (command) => {
    opened.push(command);

    return Promise.resolve({ claim, created: true });
  },
  verifyClaim: (command) => {
    checked.push(command);

    return verifyClaim === undefined
      ? Promise.resolve({ claim, verified: false, transferred: false, reason: 'not yet' })
      : verifyClaim(command);
  },
});

const app = (role: 'OWNER' | 'EDITOR', verifyClaim?: DomainsPort['verifyClaim']) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, role),
    domains: port(verifyClaim),
  });

const send = (built: ReturnType<typeof createApp>, path: string, body?: unknown) =>
  built.request(`/v1/dashboard${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('opening a claim', () => {
  it('answers 201 with the claim and the nonce to publish', async () => {
    opened.length = 0;

    const response = await send(app('OWNER'), '/domains/claims', { domain: 'www.winery.com' });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ claim, created: true });
    expect(opened).toEqual([{ tenantId: TENANT, input: 'www.winery.com' }]);
  });

  it.each([{}, { domain: '' }, { domain: 'winery.com', tenantId: 'x' }, { domain: 42 }])(
    'refuses %j without troubling the port',
    async (body) => {
      opened.length = 0;

      const response = await send(app('OWNER'), '/domains/claims', body);

      expect(response.status).toBe(422);
      expect(opened).toEqual([]);
    },
  );

  it('is an owner’s to open', async () => {
    opened.length = 0;

    const response = await send(app('EDITOR'), '/domains/claims', { domain: 'winery.com' });

    expect(response.status).toBe(403);
    expect(opened).toEqual([]);
  });
});

describe('checking a claim', () => {
  it('passes the claim id and the membership’s tenant, and answers 200 either way', async () => {
    checked.length = 0;

    const response = await send(app('OWNER'), '/domains/claims/c1/verify');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verified: false, transferred: false });
    expect(checked).toEqual([{ tenantId: TENANT, claimId: 'c1' }]);
  });

  it('is an owner’s to check', async () => {
    checked.length = 0;

    const response = await send(app('EDITOR'), '/domains/claims/c1/verify');

    expect(response.status).toBe(403);
    expect(checked).toEqual([]);
  });

  it.each([
    [new NotFoundError('No such claim.'), 404],
    [new ConflictError('That domain changed hands while we were checking it.'), 409],
  ])('answers %s with its status', async (error, status) => {
    const response = await send(
      app('OWNER', () => Promise.reject(error)),
      '/domains/claims/c1/verify',
    );

    expect(response.status).toBe(status);
  });
});
