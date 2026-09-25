import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  RateLimitedError,
} from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AddDomainCommand, DomainsPort, VerifyDomainCommand } from '../src/domains.js';
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

const verified = {
  domain: {
    id: 'd1',
    origin: 'https://www.winery.com',
    registrableDomain: 'winery.com',
    status: 'VERIFIED' as const,
    verificationToken: null,
    verificationExpiresAt: null,
    createdAt: '2026-09-25T09:00:00.000Z',
  },
  verified: true,
};

const checks: VerifyDomainCommand[] = [];

const port = (
  add: DomainsPort['add'],
  verify: DomainsPort['verify'] = () => Promise.resolve(verified),
): DomainsPort => ({
  add: (command) => {
    seen.push(command);

    return add(command);
  },
  verify: (command) => {
    checks.push(command);

    return verify(command);
  },
});

const created = {
  domain: {
    id: 'd1',
    origin: 'https://www.winery.com',
    registrableDomain: 'winery.com',
    status: 'PENDING' as const,
    verificationToken: 'a-nonce',
    verificationExpiresAt: '2026-10-02T09:00:00.000Z',
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

describe('checking a domain', () => {
  const verifyWith = (role: 'OWNER' | 'EDITOR', body: unknown, verify?: DomainsPort['verify']) =>
    createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, role),
      domains: port(() => Promise.resolve(created), verify),
    }).request('/v1/dashboard/domains/d1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers 200 with the domain and whether it passed', async () => {
    checks.length = 0;

    const response = await verifyWith('OWNER', { method: 'dns' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verified: true });
  });

  it('takes the id from the path and the tenant from the membership', async () => {
    checks.length = 0;

    await verifyWith('OWNER', { method: 'dns' });

    expect(checks[0]).toEqual({ tenantId: TENANT, domainId: 'd1', method: 'dns' });
  });

  it('answers 200 for a record that is not there yet', async () => {
    /*
     * **The contract worth stating.** For most of the minutes after a seller
     * publishes a TXT record, "not there yet" is the correct answer — and a
     * screen that has to catch an exception to render it renders it badly.
     */
    const response = await verifyWith('OWNER', { method: 'dns' }, () =>
      Promise.resolve({ ...verified, verified: false, reason: 'We could not find it yet.' }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verified: false });
  });

  it('carries the proof the seller chose, rather than picking one', async () => {
    /*
     * **Their choice, not ours.** DNS is not always theirs to change — plenty
     * would have to ask whoever built the site — and a file on the storefront
     * is. A route that picked for them would strand exactly those sellers.
     */
    checks.length = 0;

    await verifyWith('OWNER', { method: 'wellknown' });

    expect(checks[0]?.method).toBe('wellknown');
  });

  it('refuses a method it does not offer', async () => {
    checks.length = 0;

    const response = await verifyWith('OWNER', { method: 'carrier-pigeon' });

    expect(response.status).toBe(422);
    expect(checks).toEqual([]);
  });

  it('refuses a body with no method at all', async () => {
    const response = await verifyWith('OWNER', {});

    expect(response.status).toBe(422);
  });

  it('is closed to an EDITOR', async () => {
    checks.length = 0;

    const response = await verifyWith('EDITOR', { method: 'dns' });

    expect(response.status).toBe(403);
    expect(checks).toEqual([]);
  });

  it('answers 404 for a domain that is not this winery', async () => {
    const response = await verifyWith('OWNER', { method: 'dns' }, () =>
      Promise.reject(new NotFoundError('No such domain.')),
    );

    expect(response.status).toBe(404);
  });

  it('answers 429 when the domain has been checked too often', async () => {
    const response = await verifyWith('OWNER', { method: 'dns' }, () =>
      Promise.reject(new RateLimitedError('Wait a moment and try again.')),
    );

    expect(response.status).toBe(429);
  });
});
