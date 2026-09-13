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

/**
 * The `:name` segments in an endpoint, as a union of their names.
 *
 * Derived from the literal rather than declared, so `PATCH
 * /v1/dashboard/products/:id` requires an `id` and refuses anything else —
 * and a path that gains a segment makes every existing call site a compile
 * error rather than a 404 nobody can explain.
 */
export type PathParam<E extends string> = E extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParam<`/${Rest}`>
  : E extends `${string}:${infer Name}`
    ? Name
    : never;

/**
 * What a call may carry beyond its endpoint.
 *
 * `params` is required exactly when the path has segments to fill, which is
 * what keeps `:id` out of a URL. `query` and `body` are always optional: an
 * endpoint that ignores them is a server-side concern, and the client
 * refusing them would be a second contract to keep in step with the first.
 */
export type RequestOptions<E extends DashboardEndpoint> = {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined;
  readonly body?: unknown;
} & ([PathParam<E>] extends [never]
  ? { readonly params?: undefined }
  : { readonly params: Readonly<Record<PathParam<E>, string>> });

/**
 * Fills `:name` segments and refuses to leave one behind.
 *
 * **A missing parameter must never reach the network.** `/products/:id` sent
 * literally is a 404 — or worse, a route that matches something else — and the
 * caller sees a failure with no connection to the value they forgot. The type
 * above makes it a compile error; this is what catches a value that was
 * `undefined` at runtime anyway.
 *
 * Each value is encoded: an id or a SKU containing a slash would otherwise
 * change which route matches.
 */
const fillPath = (path: string, params: Readonly<Record<string, string>> | undefined): string => {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];

    if (value === undefined || value === '') {
      throw new Error(
        `The endpoint path needs a "${name}" and none was given. Sending it as ` +
          '`:' +
          name +
          '` would be a 404 with nothing to connect it to the missing value.',
      );
    }

    return encodeURIComponent(value);
  });
};

/**
 * The query string, or an empty one.
 *
 * **`undefined` is dropped rather than serialised**, which is the bug this
 * exists to prevent: `?q=undefined` is a filter the server will honour, and the
 * result is an empty catalogue that looks like an empty catalogue. Every value
 * goes through `URLSearchParams`, so encoding is not a thing any caller has to
 * remember.
 */
const queryString = (
  query: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): string => {
  if (query === undefined) return '';

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }

  const rendered = search.toString();

  return rendered === '' ? '' : `?${rendered}`;
};

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
    request: async <E extends DashboardEndpoint>(
      endpoint: E,
      ...[init]: [PathParam<E>] extends [never]
        ? [options?: RequestOptions<E>]
        : [options: RequestOptions<E>]
    ): Promise<ResponseOf<E>> => {
      const [method, path] = endpoint.split(' ') as [string, string];
      const url = `${options.baseUrl}${fillPath(path, init?.params)}${queryString(init?.query)}`;

      const response = await doFetch(url, {
        method,
        // Session cookies. The dashboard surface is cookie-authenticated; the
        // widget surface accepts none, which is why it gets its own client.
        credentials: 'include',
        // Spread rather than a ternary yielding `undefined` — with
        // `exactOptionalPropertyTypes`, a key present and holding `undefined`
        // is a different thing from an absent key, and `RequestInit` wants the
        // second.
        ...(options.activeTenantId === undefined && init?.body === undefined
          ? {}
          : {
              headers: {
                ...(options.activeTenantId === undefined
                  ? {}
                  : { 'x-active-tenant': options.activeTenantId }),
                /*
                 * Only when there is a body. Hono's validator reads the header
                 * to decide how to parse, and a `content-type: application/json`
                 * on a GET is the kind of thing a proxy or a CORS preflight
                 * treats differently for no benefit.
                 */
                ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
              },
            }),
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
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
