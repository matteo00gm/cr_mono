import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { fakeAuth } from './support/auth.js';
import { createDashboardApp } from '../src/surfaces/dashboard.js';
import { createWidgetApp } from '../src/surfaces/widget.js';

/**
 * The API skeleton (P0-54).
 *
 * Every assertion here runs against the Hono app directly via `app.request()`
 * — no Lambda event envelope, no AWS, no network. That is the reason the
 * adapter lives in `index.ts` and the app in `app.ts`.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /v1/health', () => {
  it('answers 200 with a status', async () => {
    const response = await createApp({ auth: fakeAuth() }).request('/v1/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('reports the build SHA it was deployed with', async () => {
    // "Is it up" is rarely the question; "is the thing I just deployed the
    // thing that is running" is, and nothing else in the response answers it.
    vi.stubEnv('BUILD_SHA', 'c0ffee1');

    const response = await createApp({ auth: fakeAuth() }).request('/v1/health');

    expect(await response.json()).toMatchObject({ sha: 'c0ffee1' });
  });

  it('says `unknown` rather than failing when no SHA was injected', async () => {
    /*
     * A health endpoint that 500s because a build variable is missing reports
     * a healthy deployment as dead — a worse failure than an unlabelled SHA,
     * and one that would page someone. Local runs legitimately have no SHA.
     */
    vi.stubEnv('BUILD_SHA', '');

    const response = await createApp({ auth: fakeAuth() }).request('/v1/health');

    expect(await response.json()).toMatchObject({ sha: 'unknown' });
  });

  it('is mounted under /v1, which is the path CloudFront actually routes', async () => {
    // A `/health` at the root would answer on the Function URL but never
    // through the edge (§5.1 routes `/v1/*` to this Lambda), so the check
    // would pass while every real caller's path was broken.
    const app = createApp({ auth: fakeAuth() });

    expect((await app.request('/health')).status).toBe(404);
    expect((await app.request('/v1/health')).status).toBe(200);
  });
});

describe('route surfaces', () => {
  it('mounts the dashboard and the widget at their own prefixes', async () => {
    const app = createApp({ auth: fakeAuth() });

    expect(await (await app.request('/v1/dashboard')).json()).toEqual({ surface: 'dashboard' });
    expect(await (await app.request('/v1/widget')).json()).toEqual({ surface: 'widget' });
  });

  it('mounts sub-app paths under the prefix', async () => {
    // What every real route will look like. The markers above sit at the bare
    // prefix, so on their own they would not prove that nested paths compose.
    const sub = new Hono();
    sub.get('/products', (c) => c.text('catalogue'));

    const app = new Hono();
    app.route('/v1/dashboard', sub);

    expect((await app.request('/v1/dashboard/products')).status).toBe(200);
  });

  it('does not answer the bare prefix with a trailing slash', async () => {
    /*
     * Recorded because it is surprising rather than because it matters:
     * `app.route(prefix, sub)` maps the sub-app's `/` to `prefix` exactly, so
     * `/v1/widget/` does not reach the marker while `/v1/widget` does. Harmless
     * — no real endpoint lives at the bare prefix — but worth pinning, so a
     * future Hono release accepting both is a visible change here rather than a
     * silent widening of the routing surface.
     *
     * Asserted on the widget, because the dashboard now answers 401 to any
     * unmatched path rather than 404 — see the note in `auth.test.ts`.
     */
    expect((await createApp({ auth: fakeAuth() }).request('/v1/widget/')).status).toBe(404);
  });

  it('keeps one surface middleware out of the other', async () => {
    /*
     * The property the whole two-instance split exists for, asserted rather
     * than commented.
     *
     * P0-45 mounts Better Auth on the dashboard; P2-08 mounts a permissive
     * CORS handler on the widget. On a shared instance with route groups both
     * would run for both surfaces, and the second of those is how a
     * cross-origin page ends up able to read a seller's catalogue. This fails
     * the moment someone flattens the two apps into one.
     */
    const runs = { dashboard: 0, widget: 0 };
    const surface = (name: 'dashboard' | 'widget'): Hono => {
      const sub = new Hono();
      sub.use('*', async (_c, next) => {
        runs[name] += 1;
        await next();
      });
      sub.get('/', (c) => c.json({ surface: name }));
      return sub;
    };

    const app = new Hono();
    app.route('/v1/dashboard', surface('dashboard'));
    app.route('/v1/widget', surface('widget'));

    await app.request('/v1/widget');
    expect(runs).toEqual({ dashboard: 0, widget: 1 });

    await app.request('/v1/dashboard');
    expect(runs).toEqual({ dashboard: 1, widget: 1 });
  });

  it('runs middleware only when it is registered before the route', async () => {
    /*
     * Not a quirk to work around — a trap to know about, and the reason this
     * assertion is here rather than in a comment. Hono matches middleware and
     * handlers in registration order, so a `use()` added *after* the `get()`
     * it was meant to protect never runs: the handler matches first and
     * responds.
     *
     * P0-45 mounts session middleware and P0-49 mounts a capability check.
     * Either one registered below a route is an endpoint that silently serves
     * unauthenticated traffic while every functional test of that endpoint
     * still passes — the failure mode is invisible from the route's own tests,
     * which is exactly why P0-50 enumerates routes from the router instead.
     */
    const before = new Hono();
    let ranBefore = false;
    before.use('*', async (_c, next) => {
      ranBefore = true;
      await next();
    });
    before.get('/', (c) => c.text('ok'));

    const after = new Hono();
    let ranAfter = false;
    after.get('/', (c) => c.text('ok'));
    after.use('*', async (_c, next) => {
      ranAfter = true;
      await next();
    });

    await before.request('/');
    await after.request('/');

    expect(ranBefore).toBe(true);
    expect(ranAfter).toBe(false);
  });

  it('serves each prefix from a different app, not one router', async () => {
    // Distinguishes *which* app answered, not merely that something did —
    // the distinction that matters when the bug is one surface replying for
    // the other (P0-46's surface-isolation group builds on this).
    const dashboard = await (await createApp({ auth: fakeAuth() }).request('/v1/dashboard')).json();
    const widget = await (await createApp({ auth: fakeAuth() }).request('/v1/widget')).json();

    expect(dashboard).not.toEqual(widget);
  });

  it('404s on an unknown path under an unguarded surface', async () => {
    // The widget has no session guard, so an unmatched path is simply absent.
    // The dashboard deliberately answers 401 first — `auth.test.ts` says why.
    expect((await createApp({ auth: fakeAuth() }).request('/v1/widget/nope')).status).toBe(404);
  });
});

describe('the surface factories', () => {
  it('each report their own name, so a test can tell which app answered', async () => {
    // The distinction that matters when the bug being hunted is one surface
    // replying for the other, rather than nothing replying at all.
    expect(await (await createDashboardApp({ auth: fakeAuth() }).request('/')).json()).toEqual({
      surface: 'dashboard',
    });
    expect(await (await createWidgetApp().request('/')).json()).toEqual({ surface: 'widget' });
  });

  it('hand back a new instance each time', () => {
    expect(createDashboardApp({ auth: fakeAuth() })).not.toBe(
      createDashboardApp({ auth: fakeAuth() }),
    );
    expect(createWidgetApp()).not.toBe(createWidgetApp());
  });
});

describe('createApp', () => {
  it('is a factory, so two callers never share an instance', async () => {
    /*
     * `app.route()` mutates the app it is called on. With a module-level
     * singleton, a suite that adds a stub session (P0-46) would leak it into
     * every later suite, and mounting the same instance twice would register
     * duplicate routes where the first wins and the second is dead code that
     * reads as live.
     */
    const first = createApp({ auth: fakeAuth() });
    const second = createApp({ auth: fakeAuth() });

    expect(first).not.toBe(second);

    first.get('/v1/only-on-first', (c) => c.text('here'));

    expect((await first.request('/v1/only-on-first')).status).toBe(200);
    expect((await second.request('/v1/only-on-first')).status).toBe(404);
  });
});
