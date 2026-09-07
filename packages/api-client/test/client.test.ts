import { describe, expect, it, vi } from 'vitest';

import { ApiError, createClient, DASHBOARD_RESPONSES } from '../src/index.js';

/**
 * The typed client (P0-63).
 *
 * What is worth asserting is the boundary behaviour: that a response is
 * *parsed* rather than cast, that a failure arrives as a typed error carrying
 * the request id, and that the active-tenant header is sent only when there is
 * one to send.
 */

/**
 * A typed fetch double.
 *
 * Annotated as `typeof globalThis.fetch` rather than left to inference: a bare
 * `vi.fn(() => …)` infers a zero-argument signature, so `mock.calls[0][1]` is a
 * tuple of length 0 and reading the init object is a type error.
 */
const fetchDouble = (impl: typeof globalThis.fetch) => vi.fn(impl);

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const clientWith = (impl: typeof globalThis.fetch, activeTenantId?: string) =>
  createClient({
    baseUrl: 'https://api.example.test',
    fetch: impl,
    ...(activeTenantId === undefined ? {} : { activeTenantId }),
  });

describe('a successful call', () => {
  it('returns the parsed response', async () => {
    const fetchMock = fetchDouble(() => Promise.resolve(jsonResponse({ surface: 'dashboard' })));

    await expect(clientWith(fetchMock).request('GET /v1/dashboard')).resolves.toEqual({
      surface: 'dashboard',
    });
  });

  it('derives the method and path from the endpoint key', async () => {
    // A typo in the path is a compile error rather than a 404 found at runtime,
    // because the key is a literal union.
    const fetchMock = fetchDouble(() =>
      Promise.resolve(jsonResponse({ tenantId: 't1', role: 'EDITOR' })),
    );

    await clientWith(fetchMock).request('GET /v1/dashboard/context');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/dashboard/context',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('parses rather than casts, so a changed shape fails at the boundary', async () => {
    /*
     * The reason `parse` is worth its cost. A cast would hand a component an
     * object missing `memberships`, and the failure would surface as a
     * `TypeError` three layers in with no mention of the API.
     */
    const fetchMock = fetchDouble(() => Promise.resolve(jsonResponse({ userId: 'u1' })));

    await expect(clientWith(fetchMock).request('GET /v1/dashboard/me')).rejects.toThrow();
  });
});

describe('the active tenant header', () => {
  it('is sent when the caller chose a winery', async () => {
    const fetchMock = fetchDouble(() => Promise.resolve(jsonResponse({ surface: 'dashboard' })));

    await clientWith(fetchMock, 'tenant-1').request('GET /v1/dashboard');

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'x-active-tenant': 'tenant-1' },
    });
  });

  it('is absent otherwise, rather than present and empty', async () => {
    // A header holding an empty string is a *selection* of nothing, which the
    // server would have to decide how to read. Absent is unambiguous.
    const fetchMock = fetchDouble(() => Promise.resolve(jsonResponse({ surface: 'dashboard' })));

    await clientWith(fetchMock).request('GET /v1/dashboard');

    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('headers');
  });
});

describe('a failed call', () => {
  it('throws an ApiError carrying the code and the request id', async () => {
    /*
     * The request id is the only handle a caller has on the server's log
     * (P0-55), so losing it here would make every support conversation start
     * from nothing.
     */
    const fetchMock = fetchDouble(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'forbidden',
              message: 'This role cannot billing manage.',
              requestId: 'r-1',
            },
          },
          403,
        ),
      ),
    );

    const error: unknown = await clientWith(fetchMock)
      .request('GET /v1/dashboard/context')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'forbidden', requestId: 'r-1' });
  });

  it('survives an error body that is not the expected envelope', async () => {
    // A 502 from the edge is HTML or nothing at all, and a client that threw
    // while constructing its error would replace a useful status with a
    // TypeError.
    const fetchMock = fetchDouble(() => Promise.resolve(jsonResponse({}, 502)));

    const error = (await clientWith(fetchMock)
      .request('GET /v1/dashboard')
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.status).toBe(502);
    expect(error.code).toBe('unknown');
  });
});

describe('the endpoint table', () => {
  it('covers every endpoint the client can be asked for', () => {
    // The keys are the client's entire surface; an empty table would make every
    // assertion above vacuous.
    expect(Object.keys(DASHBOARD_RESPONSES).length).toBeGreaterThan(0);
    for (const key of Object.keys(DASHBOARD_RESPONSES)) {
      expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/v1\//);
    }
  });
});
