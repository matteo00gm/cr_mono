import { ConflictError, InvalidRequestError } from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AddDomainCommand, DomainsPort } from '../src/domains.js';
import { fakeAuth, oneMembership, signedIn } from './support/auth.js';

/**
 * `POST /v1/dashboard/domains` (P4-01, §3.3).
 *
 * The *surface*: who may call it, what shape a refusal takes, and that the
 * tenant comes from the membership rather than the body (P0-48). What happens
 * underneath is `domains-port.test.ts`, and what the database enforces is
 * `packages/db/test/domains.integration.test.ts`.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

const seen: AddDomainCommand[] = [];

const port = (add: DomainsPort['add']): DomainsPort => ({
  add: (command) => {
    seen.push(command);

    return add(command);
  },
});

const created = {
  domain: {
    id: 'd1',
    origin: 'https://www.winery.com',
    registrableDomain: 'winery.com',
    status: 'PENDING' as const,
    verificationToken: 'a-nonce',
    createdAt: '2026-09-25T09:00:00.000Z',
  },
  created: true,
};

const app = (role: 'OWNER' | 'EDITOR', add: DomainsPort['add'] = () => Promise.resolve(created)) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, role),
    domains: port(add),
  });

const post = (built: ReturnType<typeof createApp>, body: unknown) =>
  built.request('/v1/dashboard/domains', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('adding a domain', () => {
  it('answers 201 with the row and its token', async () => {
    seen.length = 0;

    const response = await post(app('OWNER'), { domain: 'www.winery.com' });
    const body = (await response.json()) as typeof created;

    expect(response.status).toBe(201);
    expect(body.domain.origin).toBe('https://www.winery.com');
    /* The seller has to publish this; a response that withheld it would leave
     * the screen unable to say what to do next. */
    expect(body.domain.verificationToken).toBe('a-nonce');
  });

  it('takes the tenant from the membership, never from the body', async () => {
    seen.length = 0;

    await post(app('OWNER'), { domain: 'winery.com' });

    expect(seen[0]?.tenantId).toBe(TENANT);
  });

  it('refuses a body carrying anything else', async () => {
    /*
     * `.strict()`, so a `tenantId` in the body is refused rather than quietly
     * ignored. Ignoring it is how the next handler written in a hurry comes to
     * read it (P0-48).
     */
    seen.length = 0;

    const response = await post(app('OWNER'), { domain: 'winery.com', tenantId: 'x' });

    expect(response.status).toBe(422);
    expect(seen).toEqual([]);
  });

  it.each([{}, { domain: '' }, { domain: 'x'.repeat(301) }, { domain: 42 }])(
    'refuses %j without troubling the port',
    async (body) => {
      seen.length = 0;

      const response = await post(app('OWNER'), body);

      expect(response.status).toBe(422);
      expect(seen).toEqual([]);
    },
  );

  it('passes the raw string through, leaving one authority on what an origin is', async () => {
    seen.length = 0;

    await post(app('OWNER'), { domain: '  WWW.Winery.COM.  ' });

    expect(seen[0]?.input).toBe('  WWW.Winery.COM.  ');
  });
});

describe('who may call it', () => {
  it('is closed to an EDITOR', async () => {
    seen.length = 0;

    const response = await post(app('EDITOR'), { domain: 'winery.com' });

    expect(response.status).toBe(403);
    /* Refused before the port was reached, not after. */
    expect(seen).toEqual([]);
  });

  it('is closed to a caller with no session', async () => {
    const built = createApp({
      auth: fakeAuth(),
      readMemberships: oneMembership(TENANT, 'OWNER'),
      domains: port(() => Promise.resolve(created)),
    });

    const response = await post(built, { domain: 'winery.com' });

    expect(response.status).toBe(401);
  });
});

describe('a refusal', () => {
  it('reports a conflict as 409, with the port own words', async () => {
    const response = await post(
      app('OWNER', () => Promise.reject(new ConflictError('That domain is not available to add.'))),
      { domain: 'winery.com' },
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/not available/iu);
  });

  it('reports a normalisation failure as 422, and says what was wrong', async () => {
    /*
     * The message *is* the contract (P0-55) and reaches the seller verbatim,
     * which is the whole reason the reasons are typed: this screen is the one
     * every seller has to get through before the product works at all.
     */
    const response = await post(
      app('OWNER', () => Promise.reject(new InvalidRequestError('A domain needs a suffix.'))),
      { domain: 'winery' },
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/needs a suffix/iu);
  });

  it('never returns a non-DomainError message to the caller', async () => {
    /*
     * P0-55. A driver error's `.message` routinely carries a connection string,
     * and this route is one an unauthenticated attacker cannot reach — which is
     * exactly the kind of route where the rule stops being checked.
     */
    const response = await post(
      app('OWNER', () =>
        Promise.reject(new Error('connect ECONNREFUSED 10.0.1.42:5432 for user app_rw')),
      ),
      { domain: 'winery.com' },
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/ECONNREFUSED|10\.0\.1\.42|app_rw/u);
  });
});
