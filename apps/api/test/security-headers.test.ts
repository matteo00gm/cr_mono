import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/env.js';
import {
  API_HSTS,
  DASHBOARD_API_CSP,
  securityHeaders,
} from '../src/middleware/security-headers.js';
import { fakeAuth, oneMembership, signedIn } from './support/auth.js';

/**
 * The API's security headers, per surface (P4-12).
 *
 * Asserted on responses the real app makes — a success, a refusal, a 404, an
 * unexpected error — because a header set only on the happy path is the header
 * missing from the response an attacker is actually looking at.
 */

const app = (options: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({ auth: fakeAuth(), readMemberships: oneMembership(), ...options });

const expectEverywhere = (response: Response): void => {
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Strict-Transport-Security')).toBe(API_HSTS);
};

describe('every response', () => {
  it.each([
    ['a health check', '/v1/health'],
    ['a path nothing answers', '/v1/nowhere'],
    ['a dashboard refusal', '/v1/dashboard/me'],
    ['a widget refusal', '/v1/widget/config'],
  ])('carries nosniff and HSTS on %s', async (_name, path) => {
    expectEverywhere(await app().request(path));
  });

  it('carries them when the origin secret refuses the request outright', async () => {
    const response = await app({ originSecret: 'x'.repeat(40) }).request('/v1/health');

    /* 404 by design: a prober is not told it found the origin (A2). */
    expect(response.status).toBe(404);
    expectEverywhere(response);
  });

  it('never names the software that answered', async () => {
    const response = await app().request('/v1/health');

    expect(response.headers.get('Server')).toBeNull();
    expect(response.headers.get('X-Powered-By')).toBeNull();
  });
});

describe('the dashboard surface', () => {
  it('may not be framed, and loads nothing if it is ever rendered', async () => {
    const response = await app({ auth: signedIn() }).request('/v1/dashboard/me');

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toBe(DASHBOARD_API_CSP);
  });

  it('says so on its refusals too', async () => {
    const response = await app().request('/v1/dashboard/keys');

    expect(response.status).toBe(401);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('the widget surface', () => {
  it('never says X-Frame-Options, because the widget is embedded by design', async () => {
    const response = await app().request('/v1/widget/config', {
      headers: { origin: 'https://www.winery.example' },
    });

    expect(response.headers.get('X-Frame-Options')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toBeNull();
    expectEverywhere(response);
  });

  it('is not caught by a prefix that merely starts the same', async () => {
    /* `/v1/dashboard-x` is not the dashboard; the rule is the prefix and a slash. */
    const response = await app().request('/v1/dashboardish');

    expect(response.headers.get('X-Frame-Options')).toBeNull();
  });
});

describe('a response whose headers cannot be changed', () => {
  it('is copied rather than failing, keeping its status and location', async () => {
    const bare = new Hono<AppEnv>();
    bare.use('*', securityHeaders());
    bare.get('/', () => Response.redirect('https://dashboard.example/done', 302));

    const response = await bare.request('/');

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://dashboard.example/done');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
