import { DASHBOARD_RESPONSES, type DashboardEndpoint, type ResponseOf } from './responses.js';

export * from './responses.js';

/**
 * The typed client both consumers use instead of raw `fetch` (P0-63).
 *
 * **Hand-written and deliberately small.** The widget's bundle is a product
 * constraint rather than a preference (P3-05), and a generated client brings a
 * runtime nobody reads. What is shared is the *types*; this is the twenty lines
 * of fetch around them.
 *
 * The point of routing every call through here is not ergonomics. It is that
 * usage becomes discoverable — by find-references in an editor, by `grep`, and
 * by the consumer map in `docs/api/consumers.md` — because it is derived from
 * the calls themselves rather than from a list somebody maintains. An ESLint
 * rule forbids raw `fetch` to our own API outside this package, which is what
 * keeps that map complete.
 */

export interface ClientOptions {
  /** Origin only, no trailing slash: `https://d111111abcdef8.cloudfront.net`. */
  readonly baseUrl: string;
  /**
   * The winery to act as, when the caller belongs to more than one.
   *
   * Re-validated against `memberships` on every request, so a stale or forged
   * value fails rather than being trusted (P0-47). Sending it is a *selection*
   * among rows the server already agrees exist, never an assertion of identity.
   */
  readonly activeTenantId?: string;
  /** Swappable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Quote this in a bug report; it is the only handle on the server's log. */
    readonly requestId: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; requestId?: string };
}

export const createClient = (options: ClientOptions) => {
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    /**
     * Calls one endpoint and returns its typed response.
     *
     * The endpoint is a literal key, so a typo in a path is a compile error
     * rather than a 404 discovered at runtime — and the return type comes from
     * the same schema the server validates against.
     *
     * The body is **parsed**, not cast. A server that changed shape without the
     * schema changing would otherwise be discovered by a `TypeError` three
     * layers into a component; here it fails at the boundary, with the field
     * named.
     */
    request: async <E extends DashboardEndpoint>(endpoint: E): Promise<ResponseOf<E>> => {
      const [method, path] = endpoint.split(' ') as [string, string];

      const response = await doFetch(`${options.baseUrl}${path}`, {
        method,
        // Session cookies. The dashboard surface is cookie-authenticated; the
        // widget surface accepts none, which is why it gets its own client.
        credentials: 'include',
        // Spread rather than a ternary yielding `undefined` — with
        // `exactOptionalPropertyTypes`, a key present and holding `undefined`
        // is a different thing from an absent key, and `RequestInit` wants the
        // second.
        ...(options.activeTenantId === undefined
          ? {}
          : { headers: { 'x-active-tenant': options.activeTenantId } }),
      });

      const body: unknown = await response.json();

      if (!response.ok) {
        const error = (body as ErrorBody).error;
        throw new ApiError(
          response.status,
          error?.code ?? 'unknown',
          error?.message ?? 'The request failed.',
          error?.requestId ?? 'unknown',
        );
      }

      return DASHBOARD_RESPONSES[endpoint].parse(body) as ResponseOf<E>;
    },
  };
};

export type ApiClient = ReturnType<typeof createClient>;
