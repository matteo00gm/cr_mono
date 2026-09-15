import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { UndeclaredRouteError } from '../src/middleware/capability.js';
import type { createWidgetApp } from '../src/surfaces/widget.js';
import { fakeAuth, oneMembership } from './support/auth.js';

/**
 * The widget surface's boot check (P0-49, P2-10).
 *
 * `widget-config.test.ts` proves the table declares every route the surface
 * serves; this proves `createApp` actually *asks*. Remove the call and every
 * other suite stays green, because each route there is declared — which is the
 * shape of a guard that cannot fail.
 *
 * In its own file because the only way to plant an undeclared route on the real
 * surface is to mock the module that builds it, and `vi.mock` holds for a file.
 */

vi.mock('../src/surfaces/widget.js', async (importOriginal) => {
  const actual = await importOriginal<{ createWidgetApp: typeof createWidgetApp }>();

  return {
    ...actual,
    createWidgetApp: (...args: Parameters<typeof createWidgetApp>) => {
      const app = actual.createWidgetApp(...args);
      app.get('/planted', (c) => c.json({ planted: true }));
      return app;
    },
  };
});

describe('the widget boot check', () => {
  it('refuses to build an app whose widget serves a route nobody declared', () => {
    expect(() => createApp({ auth: fakeAuth(), readMemberships: oneMembership() })).toThrow(
      UndeclaredRouteError,
    );
  });

  it('names the route, so the failing deploy says what to declare', () => {
    expect(() => createApp({ auth: fakeAuth(), readMemberships: oneMembership() })).toThrow(
      'GET /v1/widget/planted',
    );
  });
});
