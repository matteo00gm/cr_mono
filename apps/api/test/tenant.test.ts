import { ACTIVE_TENANT_HEADER, getRequestContext } from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';

import { Hono } from 'hono';

import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/env.js';
import { requireUser } from '../src/middleware/auth.js';
import { requestContext } from '../src/middleware/logger.js';
import { resolveTenant } from '../src/middleware/tenant.js';
import { memberships, oneMembership, signedIn } from './support/auth.js';

/**
 * Tenant resolution middleware (P0-47).
 *
 * The decision itself is tested in `packages/core`; what is tested here is the
 * wiring — that the middleware sits below the session guard and above the
 * routes that need a tenant, that it reads the selection from the one header it
 * is allowed to, and that it puts both values on the context together.
 */

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const app = (reader = oneMembership(A, 'OWNER')) =>
  createApp({ auth: signedIn(), readMemberships: reader });

describe('the resolved context', () => {
  it('carries the tenant and the role together', async () => {
    const response = await app().request('/v1/dashboard/context');

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ tenantId: A, role: 'OWNER' });
  });

  it('takes the role from the selected row, not from the user', async () => {
    /*
     * The bug this middleware exists to make unwritable. This user is EDITOR on
     * A and OWNER on B — entirely legitimate — and an implementation carrying a
     * role cached per *user* would grant them OWNER on A.
     */
    const both = memberships([
      { tenantId: A, role: 'EDITOR' },
      { tenantId: B, role: 'OWNER' },
    ]);

    const onA = await app(both).request('/v1/dashboard/context', {
      headers: { [ACTIVE_TENANT_HEADER]: A },
    });
    const onB = await app(both).request('/v1/dashboard/context', {
      headers: { [ACTIVE_TENANT_HEADER]: B },
    });

    expect(await body(onA)).toEqual({ tenantId: A, role: 'EDITOR' });
    expect(await body(onB)).toEqual({ tenantId: B, role: 'OWNER' });
  });
});

describe('a tenant the caller does not belong to', () => {
  it('is refused with 404, not 403', async () => {
    // §3.5: a 403 for a real winery and a 404 for a made-up one lets anyone
    // with an account map which tenant ids exist.
    const response = await app().request('/v1/dashboard/context', {
      headers: { [ACTIVE_TENANT_HEADER]: B },
    });

    expect(response.status).toBe(404);
  });

  it('does not name the tenant back in the message', async () => {
    // Echoing the requested id would put it in logs and error reports, and
    // gives a probe something to correlate on.
    const response = await app().request('/v1/dashboard/context', {
      headers: { [ACTIVE_TENANT_HEADER]: B },
    });

    expect(JSON.stringify(await body(response))).not.toContain(B);
  });
});

describe('a caller with no memberships', () => {
  it('is refused with 403, and the contrast is deliberate', async () => {
    // Nothing is named, so there is no existence to leak — and a 404 would
    // send an invited-then-revoked user looking for a broken URL.
    const response = await app(memberships([])).request('/v1/dashboard/context');

    expect(response.status).toBe(403);
  });
});

describe('several memberships and no selection', () => {
  it('is refused rather than guessed', async () => {
    const response = await app(
      memberships([
        { tenantId: A, role: 'EDITOR' },
        { tenantId: B, role: 'OWNER' },
      ]),
    ).request('/v1/dashboard/context');

    expect(response.status).toBe(422);
  });
});

describe('where the middleware sits', () => {
  it('runs below the session guard, so an anonymous caller never reaches it', async () => {
    /*
     * Order matters and is asserted, not assumed. If tenant resolution ran
     * first it would call `c.get('userId')` on a request that has none — and
     * `resolveMembership` would be handed `undefined`, which typechecks
     * perfectly and fails somewhere far away.
     */
    let reads = 0;
    const counting = () => {
      reads += 1;
      return Promise.resolve([{ tenantId: A, role: 'OWNER' as const }]);
    };

    const response = await createApp({
      auth: (await import('./support/auth.js')).fakeAuth(),
      readMemberships: counting,
    }).request('/v1/dashboard/context');

    expect(response.status).toBe(401);
    expect(reads).toBe(0);
  });

  it('runs above the routes that need a tenant, and below /me', async () => {
    /*
     * `/me` has to work without an active tenant — a user with several
     * memberships cannot pick from a list they are not allowed to fetch. This
     * is the bootstrap call for the dashboard shell (P0-57).
     */
    const both = memberships([
      { tenantId: A, role: 'EDITOR' },
      { tenantId: B, role: 'OWNER' },
    ]);

    const me = await app(both).request('/v1/dashboard/me');
    const context = await app(both).request('/v1/dashboard/context');

    expect(me.status).toBe(200);
    expect(context.status).toBe(422);
  });

  it('does not run on the widget surface at all', async () => {
    let reads = 0;
    const counting = () => {
      reads += 1;
      return Promise.resolve([]);
    };

    await createApp({ auth: signedIn(), readMemberships: counting }).request('/v1/widget');

    expect(reads).toBe(0);
  });
});

describe('the tenant on the log line', () => {
  it('is set by the middleware for the rest of the request', async () => {
    /*
     * Debugging a multi-tenant system without `tenant_id` on every line is
     * guesswork (P0-55). Asserted from inside a handler rather than from
     * outside, because `requestContext()` opens its own store per request —
     * which is the whole reason two concurrent requests cannot mix.
     *
     * It is set the moment the tenant is *known*, not before: lines emitted
     * during authentication legitimately have none.
     */
    const seen: (string | undefined)[] = [];

    const app = new Hono<AppEnv>();
    app.use('*', requestContext());
    app.use('*', requireUser(signedIn()));
    app.use('*', resolveTenant(oneMembership(A, 'OWNER')));
    app.get('/', (c) => {
      seen.push(getRequestContext()?.tenantId);
      return c.text(c.get('tenantId'));
    });

    await app.request('/');

    expect(seen).toEqual([A]);
  });
});
