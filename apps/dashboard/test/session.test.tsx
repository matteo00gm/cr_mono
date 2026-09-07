import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/app.js';
import {
  ACTIVE_TENANT_KEY,
  apiFor,
  authClient,
  rememberTenant,
  useSession,
} from '../src/session.js';
import type { ApiClient } from '@catalogorosso/api-client';

/**
 * Session resolution and the clients it uses (P0-57).
 *
 * The API client is injected rather than stubbed globally, which is why these
 * are plain component tests with no network: `createClient` captures
 * `globalThis.fetch` at construction, so a module-level instance would freeze
 * whichever `fetch` existed at first import — invisible in a browser, and the
 * reason both clients here are built on demand.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

/** A client that answers `/me` with whatever the test wants. */
const clientAnswering = (body: unknown, ok = true): ApiClient =>
  ({
    request: () => (ok ? Promise.resolve(body) : Promise.reject(new Error('unauthenticated'))),
  }) as unknown as ApiClient;

const Probe = ({ client }: { readonly client: ApiClient }) => {
  const session = useSession(client);

  return (
    <p data-testid="status">
      {session.status}
      {session.status === 'signed-in' ? `:${session.active?.role ?? 'none'}` : ''}
    </p>
  );
};

afterEach(() => {
  cleanup();
  try {
    globalThis.localStorage.clear();
  } catch {
    // Storage may be unavailable; nothing to clean up if so.
  }
});

describe('useSession', () => {
  it('starts as loading and resolves to signed-in', async () => {
    render(
      <Probe
        client={clientAnswering({
          userId: 'user_matteo',
          memberships: [{ tenantId: TENANT, role: 'OWNER' }],
        })}
      />,
    );

    // The first paint is `loading`, never `signed-out`. Rendering "session
    // expired" during the first request is the flash every user reads as
    // having been logged out.
    expect(screen.getByTestId('status').textContent).toBe('loading');

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('signed-in:OWNER');
    });
  });

  it('treats any failure as signed out', async () => {
    render(<Probe client={clientAnswering(null, false)} />);

    /*
     * The safe direction. The alternative — rendering the console
     * optimistically — shows a seller an empty catalogue and lets them believe
     * their data is gone, which is a support call rather than a login prompt.
     */
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('signed-out');
    });
  });

  it('honours a remembered winery', async () => {
    rememberTenant(TENANT);

    render(
      <Probe
        client={clientAnswering({
          userId: 'user_matteo',
          memberships: [
            { tenantId: '22222222-2222-2222-2222-222222222222', role: 'EDITOR' },
            { tenantId: TENANT, role: 'OWNER' },
          ],
        })}
      />,
    );

    // Second in the list, and chosen — so this is the stored preference and not
    // an accidental "first membership wins".
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('signed-in:OWNER');
    });
  });

  it('asks rather than guessing when several wineries and no memory', async () => {
    render(
      <Probe
        client={clientAnswering({
          userId: 'user_matteo',
          memberships: [
            { tenantId: TENANT, role: 'OWNER' },
            { tenantId: '22222222-2222-2222-2222-222222222222', role: 'EDITOR' },
          ],
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('signed-in:none');
    });
  });
});

describe('rememberTenant', () => {
  it('round-trips through storage', () => {
    rememberTenant(TENANT);
    expect(globalThis.localStorage.getItem(ACTIVE_TENANT_KEY)).toBe(TENANT);
  });

  it('survives storage being unavailable', () => {
    /*
     * Private browsing, or a browser configured to block storage. The choice is
     * a *preference*, not a credential — the server re-validates it against a
     * memberships row on every request (P0-47) — so losing it must degrade to
     * "show the picker", never to a thrown error in a render path.
     */
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(() => {
      rememberTenant(TENANT);
    }).not.toThrow();

    setItem.mockRestore();
  });
});

describe('the clients', () => {
  it('scopes a request to the chosen winery', async () => {
    /*
     * Annotated as the real `fetch`, because `vi.fn(() => ...)` infers a
     * zero-argument signature — so `mock.calls[0]` is a length-0 tuple and
     * reading `[1]` off it is a typecheck error rather than the `RequestInit`
     * this test needs.
     */
    const fetchSpy = vi.fn(() =>
      Promise.resolve(Response.json({ tenantId: TENANT, role: 'OWNER' })),
    ) as unknown as typeof globalThis.fetch;
    vi.stubGlobal('fetch', fetchSpy);

    await apiFor(TENANT).request('GET /v1/dashboard/context');

    const init = vi.mocked(fetchSpy).mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.['x-active-tenant']).toBe(TENANT);

    vi.unstubAllGlobals();
  });

  it('builds the auth client once, against an absolute URL', () => {
    // Better Auth resolves its base URL at construction and throws on a
    // relative one — which is why this is built on demand rather than at module
    // scope, and why importing this module for a pure helper does not need a
    // working `location`.
    expect(authClient()).toBe(authClient());
  });
});

describe('App', () => {
  it('renders the console once the session resolves', async () => {
    render(
      <App
        client={clientAnswering({
          userId: 'user_matteo',
          memberships: [{ tenantId: TENANT, role: 'OWNER' }],
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Sezioni' })).not.toBeNull();
    });
  });

  it('renders the sign-in prompt when there is no session', async () => {
    render(<App client={clientAnswering(null, false)} />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Accedi' })).not.toBeNull();
    });
  });
});
