import type { StepUpState } from '@catalogorosso/core';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/env.js';
import { errorHandler } from '../src/middleware/error.js';
import { isStepUpGuard, requireStepUp } from '../src/middleware/step-up.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * Fresh verification for a sensitive action, without a database (P4-11).
 *
 * The guard's three answers and the routes it sits on. That it reads the
 * session *row* rather than the cookie cache is a property of the real
 * `stepUpState` against real Postgres, and is proved in `mfa.integration`.
 */

const USER = 'user_owner';

const body = async (response: Response): Promise<{ error: { code: string } }> =>
  (await response.json()) as { error: { code: string } };

const guarded = (state: StepUpState | null, userId = USER) => {
  const app = new Hono<AppEnv>();
  const asked: Headers[] = [];

  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  app.post(
    '/',
    requireStepUp({
      stepUpState: (headers) => {
        asked.push(headers);
        return Promise.resolve(state);
      },
    }),
    (c) => c.text('done'),
  );

  return { app, asked };
};

describe('the step-up guard', () => {
  it('lets a freshly verified session through', async () => {
    const { app } = guarded({ userId: USER, twoFactorEnabled: true, fresh: true });

    expect((await app.request('/', { method: 'POST' })).status).toBe(200);
  });

  it('asks a stale session for a code, by a code the dashboard can act on', async () => {
    const { app } = guarded({ userId: USER, twoFactorEnabled: true, fresh: false });
    const response = await app.request('/', { method: 'POST' });

    expect(response.status).toBe(403);
    expect((await body(response)).error.code).toBe('step_up_required');
  });

  it('sends somebody with no second factor to enrol, since no code could help', async () => {
    const { app } = guarded({ userId: USER, twoFactorEnabled: false, fresh: false });

    expect((await body(await app.request('/', { method: 'POST' }))).error.code).toBe(
      'mfa_required',
    );
  });

  it('refuses a session the table no longer holds, as signed out', async () => {
    const { app } = guarded(null);

    expect((await app.request('/', { method: 'POST' })).status).toBe(401);
  });

  it('refuses a state that names somebody other than the request user', async () => {
    const { app } = guarded({ userId: 'user_somebody_else', twoFactorEnabled: true, fresh: true });

    expect((await app.request('/', { method: 'POST' })).status).toBe(401);
  });

  it('hands over the request headers, which carry the cookie', async () => {
    const { app, asked } = guarded({ userId: USER, twoFactorEnabled: true, fresh: true });

    await app.request('/', { method: 'POST', headers: { cookie: 'session=abc' } });

    expect(asked[0]?.get('cookie')).toBe('session=abc');
  });
});

describe('the routes that need it', () => {
  /*
   * **Walked off the router rather than listed from memory** (the P0-50
   * technique). A sensitive route that lost its step-up behaves identically to
   * one that kept it for every caller whose verification happens to be fresh,
   * so no behavioural test on the route itself would notice.
   */
  const stepUpRoutes = (): string[] => {
    const app = createApp({ auth: signedIn(), readMemberships: oneMembership() });

    return app.routes
      .filter((route) => isStepUpGuard(route.handler))
      .map((route) => `${route.method} ${route.path}`)
      .sort();
  };

  it('are exactly the ones that change who can act for a winery, or how', () => {
    expect(stepUpRoutes()).toEqual(
      [
        'DELETE /v1/dashboard/domains/:id',
        'DELETE /v1/dashboard/members/:userId',
        'PATCH /v1/dashboard/members/:userId',
        'POST /v1/dashboard/keys',
        'POST /v1/dashboard/keys/public/rotate',
        'POST /v1/dashboard/keys/secret/rotate',
        'POST /v1/dashboard/members/invite',
      ].sort(),
    );
  });

  it('come after the capability check, so an EDITOR hears about their role', async () => {
    const app = createApp({
      auth: signedIn(USER, { fresh: false }),
      readMemberships: oneMembership(undefined, 'EDITOR'),
    });

    const response = await app.request('/v1/dashboard/keys', { method: 'POST' });

    expect((await body(response)).error.code).toBe('forbidden');
  });

  it('challenge an owner whose verification has gone stale', async () => {
    const app = createApp({
      auth: signedIn(USER, { fresh: false }),
      readMemberships: oneMembership(),
    });

    const response = await app.request('/v1/dashboard/members/user_editor', {
      method: 'DELETE',
    });

    expect((await body(response)).error.code).toBe('step_up_required');
  });

  it('leave a read alone, however stale', async () => {
    const app = createApp({
      auth: signedIn(USER, { fresh: false }),
      readMemberships: oneMembership(),
    });

    const response = await app.request('/v1/dashboard/keys');

    expect(response.status).not.toBe(403);
  });
});
