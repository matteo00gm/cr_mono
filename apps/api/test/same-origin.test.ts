import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { CROSS_ORIGIN_REFUSED } from '../src/middleware/same-origin.js';
import { fakeAuth, oneMembership, signedIn } from './support/auth.js';

/**
 * State-changing dashboard requests come from the dashboard (review, R5).
 *
 * Driven through the real app, on routes that exist: the guard has to sit in
 * front of Better Auth's endpoints and ours alike, and a request it lets through
 * has to reach the handler it was meant for.
 */

const DASHBOARD = 'https://app.cantina.example';

const app = (options: { dashboardOrigin?: string } = { dashboardOrigin: DASHBOARD }) =>
  createApp({ auth: signedIn(), readMemberships: oneMembership(), ...options });

const put = (
  built: ReturnType<typeof app>,
  headers: Record<string, string>,
  path = '/v1/dashboard/widget/turnstile',
) =>
  built.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ enabled: true }),
  });

const refused = async (response: Response): Promise<boolean> =>
  response.status === 403 &&
  ((await response.json()) as { error: { message: string } }).error.message ===
    CROSS_ORIGIN_REFUSED;

describe('a write to the dashboard', () => {
  it('is refused from another origin', async () => {
    expect(await refused(await put(app(), { origin: 'https://evil.example' }))).toBe(true);
  });

  it('is refused from a sibling on the same site, which SameSite=Lax would let through', async () => {
    expect(
      await refused(
        await put(app(), { origin: 'https://docs.cantina.example', 'sec-fetch-site': 'same-site' }),
      ),
    ).toBe(true);
  });

  it('is refused when the browser marks it same-site, with no Origin to go on', async () => {
    /* Only the Sec-Fetch-Site check can refuse this one: there is no Origin to compare. */
    expect(await refused(await put(app(), { 'sec-fetch-site': 'same-site' }))).toBe(true);
  });

  it('is refused when the browser marks it cross-site, even with no Origin', async () => {
    expect(await refused(await put(app(), { 'sec-fetch-site': 'cross-site' }))).toBe(true);
  });

  it('is refused on Better Auth’s own endpoints too', async () => {
    const response = await put(
      app(),
      { origin: 'https://evil.example' },
      '/v1/dashboard/auth/two-factor/disable',
    );

    expect(await refused(response)).toBe(true);
  });

  it('goes through from the dashboard itself', async () => {
    const response = await put(app(), { origin: DASHBOARD, 'sec-fetch-site': 'same-origin' });

    expect(await refused(response)).toBe(false);
  });

  it('goes through from a caller that is not a browser, which CSRF cannot use', async () => {
    expect(await refused(await put(app(), {}))).toBe(false);
  });
});

describe('a read of the dashboard', () => {
  it('is never refused for its origin: it changes nothing', async () => {
    const response = await app().request('/v1/dashboard/me', {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });

    expect(response.status).toBe(200);
  });
});

describe('without a configured origin', () => {
  it('checks nothing, which only a suite or a local run is allowed', async () => {
    const bare = createApp({ auth: fakeAuth(), readMemberships: oneMembership() });
    const response = await put(bare, { origin: 'https://evil.example' });

    expect(await refused(response)).toBe(false);
  });
});
