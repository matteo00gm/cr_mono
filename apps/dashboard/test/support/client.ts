import type { ApiClient, Product } from '@catalogorosso/api-client';
import { vi } from 'vitest';

/** What a test sees of a call: the options `request` was given. */
export interface Sent {
  readonly query?: Readonly<Record<string, unknown>>;
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export type Route = (init: Sent | undefined) => Promise<unknown>;

/**
 * A client that answers each endpoint however the test says.
 *
 * An endpoint it was not told about is refused rather than left pending, so a
 * screen calling something unexpected fails with the endpoint named instead of
 * hanging on a promise nobody resolves.
 */
export const fakeClient = (routes: Readonly<Record<string, Route>>) => {
  const request = vi.fn((endpoint: string, init?: Sent) => {
    const route = routes[endpoint];
    return route === undefined
      ? Promise.reject(new Error(`unexpected call: ${endpoint}`))
      : route(init);
  });

  return { client: { request } as unknown as ApiClient, request };
};

/** One page of the catalogue, as `GET /products` answers. */
export const listOf = (
  items: readonly Product[],
  over: { nextCursor?: string | null; matchedBy?: 'exact' | 'similar' | null } = {},
) => ({ items, nextCursor: null, matchedBy: null, ...over });
