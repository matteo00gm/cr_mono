import { createAuthClient } from 'better-auth/client';
import { useEffect, useState } from 'preact/hooks';

import { createClient, type ApiClient, type Membership } from '@catalogorosso/api-client';

/**
 * Who is signed in, and which winery they are working in (P0-57).
 *
 * Two separate questions, resolved in that order, and the separation mirrors
 * the API's (P0-45, P0-47). Better Auth answers *who*; `/v1/dashboard/me`
 * answers *which wineries*, because a role belongs to a membership and never to
 * a user — somebody can be OWNER of one winery and EDITOR of another, and a
 * role cached per user grants them the higher one on both.
 */

/** The mount path P0-45 chose for Better Auth's own endpoints. */
export const AUTH_BASE_PATH = '/v1/dashboard/auth';

let client: ReturnType<typeof createAuthClient> | undefined;

/**
 * Better Auth's browser client, built on first use.
 *
 * **Lazy, and that is not a micro-optimisation.** `createAuthClient` resolves
 * its base URL at construction and throws on a relative one, so building it at
 * module scope makes importing this module — for `chooseActive`, a pure
 * function with no network in it — depend on a working `location`. The first
 * version did exactly that and took the component suite down with it.
 *
 * The URL is absolute for the same reason: the library requires a protocol. It
 * is still same-origin, because CloudFront serves this bundle and the API from
 * one host (P0-17a) and the dev server proxies `/v1` — so the session cookie is
 * first-party and no CORS is involved.
 */
export const authClient = (): ReturnType<typeof createAuthClient> => {
  client ??= createAuthClient({
    baseURL: `${globalThis.location.origin}${AUTH_BASE_PATH}`,
  });

  return client;
};

/**
 * The typed API client (P0-63).
 *
 * `baseUrl` is empty because the bundle and the API share an origin: CloudFront
 * routes the API prefix to the Lambda and everything else to this SPA (P0-17a),
 * and the dev server proxies it so the two behave the same locally. The client
 * sends the session cookie itself — the dashboard surface is
 * cookie-authenticated and the widget surface deliberately accepts none (§3.4),
 * which is why they do not share one.
 *
 * Built on demand rather than at module scope, for the same reason the auth
 * client is: `createClient` captures `globalThis.fetch` at construction, so a
 * module-level instance freezes whichever `fetch` existed when the module was
 * first imported. That is invisible in a browser and wrong everywhere else.
 */
export const api = (): ApiClient => createClient({ baseUrl: '' });

/**
 * The same client, scoped to one winery.
 *
 * The active tenant is threaded per client rather than baked into one shared
 * instance, because it changes while the page is open — and because the server
 * re-validates it against a `memberships` row on every request (P0-47), so
 * sending it is a *selection*, never an assertion of identity.
 */
export const apiFor = (tenantId: string): ApiClient =>
  createClient({ baseUrl: '', activeTenantId: tenantId });

export const ACTIVE_TENANT_KEY = 'sommelier.activeTenant';

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | {
      readonly status: 'signed-in';
      readonly userId: string;
      readonly memberships: readonly Membership[];
      /** The chosen winery, or `undefined` while the user has yet to choose. */
      readonly active: Membership | undefined;
    };

/**
 * Remembers the chosen winery across reloads.
 *
 * `localStorage` and not a cookie, deliberately: it is a *preference*, not a
 * credential. The server re-validates the choice against a `memberships` row on
 * every request (P0-47), so a stale or edited value fails closed rather than
 * granting anything — which is what makes it safe to keep somewhere the user
 * can edit.
 */
const rememberedTenant = (): string | undefined => {
  try {
    return globalThis.localStorage.getItem(ACTIVE_TENANT_KEY) ?? undefined;
  } catch {
    // Private browsing, or storage disabled. Falling back to "no choice yet"
    // is correct: the picker appears, which is a worse experience and not a
    // broken one.
    return undefined;
  }
};

export const rememberTenant = (tenantId: string): void => {
  try {
    globalThis.localStorage.setItem(ACTIVE_TENANT_KEY, tenantId);
  } catch {
    // Nothing to do. The choice survives this page view either way.
  }
};

/**
 * Picks the active membership from what the server said.
 *
 * Exported and pure so the interesting rules — one winery needs no choice, a
 * remembered id that is no longer a membership is ignored — are testable
 * without a fetch or a DOM.
 */
export const chooseActive = (
  memberships: readonly Membership[],
  remembered: string | undefined,
): Membership | undefined => {
  const match = memberships.find((membership) => membership.tenantId === remembered);
  if (match) return match;

  /*
   * One membership means no choice to make, which is the overwhelmingly common
   * case. More than one and no valid remembered id means the user has to pick —
   * never a default, because "first" is whatever order the server returned and
   * writing to the wrong winery is silent.
   */
  return memberships.length === 1 ? memberships[0] : undefined;
};

/**
 * Resolves the session once, on mount.
 *
 * Takes a client so the states below can be exercised without a network or a
 * global stub — the same injection the API uses for its ports, and the reason
 * `chooseActive` is separate and pure.
 */
export const useSession = (client?: ApiClient): SessionState => {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    const load = async (): Promise<void> => {
      try {
        const me = await (client ?? api()).request('GET /v1/dashboard/me');
        if (!live) return;

        setState({
          status: 'signed-in',
          userId: me.userId,
          memberships: me.memberships,
          active: chooseActive(me.memberships, rememberedTenant()),
        });
      } catch {
        /*
         * Any failure is treated as signed out, and that is the safe direction:
         * the alternative — rendering the console optimistically — shows a
         * seller an empty catalogue and lets them believe their data is gone.
         * The API refuses everything without a session anyway (P0-49).
         */
        if (live) setState({ status: 'signed-out' });
      }
    };

    void load();

    return () => {
      // The component can unmount while the request is in flight — a fast
      // sign-out, or a route change — and setting state after that is a leak
      // warning in development and a wasted render in production.
      live = false;
    };
    /*
     * Once, on mount. `client` is deliberately absent from the dependency list:
     * a caller that builds one inline — which is the default path, `api()` —
     * would otherwise hand a new object every render and re-fetch the session
     * forever.
     */
  }, []);

  return state;
};
