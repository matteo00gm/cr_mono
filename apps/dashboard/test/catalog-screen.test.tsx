import { ApiError, type ApiClient, type Product } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Layout } from '../src/app.js';
import { CatalogScreen, mergeProducts, PAGE_SIZE } from '../src/features/catalog/CatalogScreen.js';
import { INDEX_STATE_COPY, POLL_START_MS } from '../src/features/catalog/IndexStatus.js';
import { wine } from './support/wine.js';

/**
 * The catalogue screen (P1-10b).
 *
 * **Most of what can go wrong here produces a plausible list rather than an
 * error**: an old search's answer replacing a new one, a refresh that
 * reorders rows under a pointer, a conflict shown as a failure. So the
 * assertions are about *which* rows are on screen and in what order, not only
 * that some are.
 */

const LIST = 'GET /v1/dashboard/products';
const REINDEX_ALL = 'POST /v1/dashboard/products/reindex-all';
const REINDEX_ONE = 'POST /v1/dashboard/products/:id/reindex';
const TENANT = '11111111-1111-1111-1111-111111111111';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.history.pushState({}, '', '/');
});

interface Sent {
  readonly query?: Readonly<Record<string, unknown>>;
  readonly params?: Readonly<Record<string, string>>;
}

type Route = (init: Sent | undefined) => Promise<unknown>;

const fakeClient = (routes: Readonly<Record<string, Route>>) => {
  const request = vi.fn((endpoint: string, init?: Sent) => {
    const route = routes[endpoint];
    return route === undefined
      ? Promise.reject(new Error(`unexpected call: ${endpoint}`))
      : route(init);
  });

  return { client: { request } as unknown as ApiClient, request };
};

const listOf = (
  items: readonly Product[],
  over: { nextCursor?: string | null; matchedBy?: 'exact' | 'similar' | null } = {},
) => ({ items, nextCursor: null, matchedBy: null, ...over });

/** The name cell of every data row, in the order a seller reads them. */
const names = (): (string | null | undefined)[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('[role="gridcell"]')?.textContent);

const firstPage = { query: { q: undefined, cursor: undefined, limit: PAGE_SIZE } };

const searchFor = (phrase: string) => {
  fireEvent.input(screen.getByRole('searchbox'), { target: { value: phrase } });
  fireEvent.submit(screen.getByRole('search'));
};

describe('the list', () => {
  it('shows the first page, with each wine’s index state', async () => {
    const { client, request } = fakeClient({
      [LIST]: () =>
        Promise.resolve(
          listOf([
            wine({ id: 'a', name: 'Barolo Bussia' }),
            wine({ id: 'b', name: 'Etna Rosso', embeddingState: 'FAILED' }),
          ]),
        ),
    });

    render(<CatalogScreen client={client} />);

    await waitFor(() => {
      expect(names()).toEqual(['Barolo Bussia', 'Etna Rosso']);
    });
    expect(request).toHaveBeenCalledWith(LIST, firstPage);
    expect(screen.getByTitle(INDEX_STATE_COPY.FAILED.description)).toBeTruthy();
    // The failure is loud, not only a dot in a column.
    expect(screen.getByRole('alert').textContent).toMatch(/^1 vino/);
  });

  it('loads more with the cursor it was given, and stops offering when there is none', async () => {
    const { client, request } = fakeClient({
      [LIST]: (init) =>
        Promise.resolve(
          init?.query?.cursor === 'c1'
            ? listOf([wine({ id: 'b', name: 'Secondo' })])
            : listOf([wine({ id: 'a', name: 'Primo' })], { nextCursor: 'c1' }),
        ),
    });

    render(<CatalogScreen client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Carica altri vini' }));

    await waitFor(() => {
      expect(names()).toEqual(['Primo', 'Secondo']);
    });
    expect(request).toHaveBeenLastCalledWith(LIST, {
      query: { q: undefined, cursor: 'c1', limit: PAGE_SIZE },
    });
    expect(screen.queryByRole('button', { name: 'Carica altri vini' })).toBeNull();
  });

  it('says so when more rows could not be loaded, keeping the ones it has', async () => {
    const { client } = fakeClient({
      [LIST]: (init) =>
        init?.query?.cursor === 'c1'
          ? Promise.reject(new ApiError(500, 'internal', 'boom', 'req_more'))
          : Promise.resolve(listOf([wine({ id: 'a', name: 'Primo' })], { nextCursor: 'c1' })),
    });

    render(<CatalogScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Carica altri vini' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('req_more');
    });
    expect(names()).toEqual(['Primo']);
  });

  it('offers a retry when the catalogue does not load', async () => {
    let calls = 0;
    const { client } = fakeClient({
      [LIST]: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ApiError(503, 'unavailable', 'Service Unavailable', 'req_load'))
          : Promise.resolve(listOf([wine({ name: 'Arrivato' })]));
      },
    });

    render(<CatalogScreen client={client} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Non è stato possibile caricare il catalogo');
    expect(alert.textContent).toContain('req_load');
    expect(alert.textContent).not.toContain('Service Unavailable');

    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }));

    await waitFor(() => {
      expect(names()).toEqual(['Arrivato']);
    });
  });
});

describe('search', () => {
  it('sends the phrase, and says when the match is only similar', async () => {
    const { client, request } = fakeClient({
      [LIST]: (init) =>
        Promise.resolve(
          init?.query?.q === 'barolo'
            ? listOf([wine({ id: 's', name: 'Barbaresco' })], { matchedBy: 'similar' })
            : listOf([wine({ id: 'a', name: 'Iniziale' })]),
        ),
    });

    render(<CatalogScreen client={client} />);
    await waitFor(() => {
      expect(names()).toEqual(['Iniziale']);
    });

    searchFor('  barolo ');

    await waitFor(() => {
      expect(names()).toEqual(['Barbaresco']);
    });
    expect(request).toHaveBeenLastCalledWith(LIST, {
      query: { q: 'barolo', cursor: undefined, limit: PAGE_SIZE },
    });
    expect(screen.getByText(/Nessuna corrispondenza esatta/)).toBeTruthy();
  });

  it('discards an answer that arrives after a newer search', async () => {
    let releaseOld: (value: unknown) => void = () => undefined;

    const { client } = fakeClient({
      [LIST]: (init) => {
        const q = init?.query?.q;
        if (q === 'vecchia') {
          return new Promise((resolve) => {
            releaseOld = resolve;
          });
        }
        return Promise.resolve(
          listOf([wine({ id: String(q), name: q === 'nuova' ? 'Nuova' : 'Iniziale' })]),
        );
      },
    });

    render(<CatalogScreen client={client} />);
    await waitFor(() => {
      expect(names()).toEqual(['Iniziale']);
    });

    searchFor('vecchia');
    searchFor('nuova');

    await waitFor(() => {
      expect(names()).toEqual(['Nuova']);
    });

    releaseOld(listOf([wine({ id: 'v', name: 'Vecchia' })]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(names()).toEqual(['Nuova']);
  });

  it('says when a search matched nothing, rather than that the catalogue is empty', async () => {
    const { client } = fakeClient({
      [LIST]: (init) =>
        Promise.resolve(
          init?.query?.q === 'zzz' ? listOf([]) : listOf([wine({ name: 'Iniziale' })]),
        ),
    });

    render(<CatalogScreen client={client} />);
    await waitFor(() => {
      expect(names()).toEqual(['Iniziale']);
    });

    searchFor('zzz');

    expect(await screen.findByText('Nessun vino corrisponde alla ricerca.')).toBeTruthy();
  });
});

describe('reindexing', () => {
  it('reindexes the whole catalogue, says how many were queued, and shows the new states', async () => {
    let state: Product['embeddingState'] = 'INDEXED';
    const { client, request } = fakeClient({
      [LIST]: () =>
        Promise.resolve(
          listOf([wine({ id: 'a', embeddingState: state }), wine({ id: 'b', name: 'Etna' })]),
        ),
      [REINDEX_ALL]: () => {
        state = 'STALE';
        return Promise.resolve({ batchId: 'batch-1', queued: 2 });
      },
    });

    render(<CatalogScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reindicizza tutto il catalogo' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        '2 vini in coda per la reindicizzazione.',
      );
    });
    await waitFor(() => {
      expect(screen.getByTitle(INDEX_STATE_COPY.STALE.description)).toBeTruthy();
    });
    expect(request).toHaveBeenCalledWith(REINDEX_ALL);
  });

  it.each([
    [0, 'Nessun vino attivo da reindicizzare.'],
    [1, '1 vino in coda per la reindicizzazione.'],
  ])('words a queue of %i', async (queued, words) => {
    const { client } = fakeClient({
      [LIST]: () => Promise.resolve(listOf([wine()])),
      [REINDEX_ALL]: () => Promise.resolve({ batchId: 'b', queued }),
    });

    render(<CatalogScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reindicizza tutto il catalogo' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(words);
    });
  });

  it('says a run is already going, in Italian, rather than reporting a failure', async () => {
    const { client } = fakeClient({
      [LIST]: () => Promise.resolve(listOf([wine()])),
      [REINDEX_ALL]: () =>
        Promise.reject(
          new ApiError(409, 'conflict', 'A reindex is already running for this catalogue', 'req_1'),
        ),
    });

    render(<CatalogScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reindicizza tutto il catalogo' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('già in corso');
    expect(status.textContent).not.toContain('already');
    expect(status.textContent).not.toContain('req_1');
  });

  it('reports any other refusal with its request id', async () => {
    const { client } = fakeClient({
      [LIST]: () => Promise.resolve(listOf([wine()])),
      [REINDEX_ALL]: () => Promise.reject(new ApiError(500, 'internal', 'boom', 'req_2')),
    });

    render(<CatalogScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reindicizza tutto il catalogo' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('non avviata');
    expect(status.textContent).toContain('req_2');
  });

  it('replaces a row with the answer to its own reindex', async () => {
    const { client } = fakeClient({
      [LIST]: () => Promise.resolve(listOf([wine({ id: 'a', name: 'Barolo Bussia' })])),
      [REINDEX_ONE]: () =>
        Promise.resolve({
          product: wine({ id: 'a', name: 'Barolo Bussia', embeddingState: 'STALE' }),
          queued: true,
        }),
    });

    render(<CatalogScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: /Barolo Bussia/ }));

    await waitFor(() => {
      expect(screen.getByTitle(INDEX_STATE_COPY.STALE.description)).toBeTruthy();
    });
  });

  it('refreshes wines that are still settling, and shows where they landed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state: Product['embeddingState'] = 'PENDING';
    const { client, request } = fakeClient({
      [LIST]: () => Promise.resolve(listOf([wine({ embeddingState: state })])),
    });

    render(<CatalogScreen client={client} />);
    await waitFor(() => {
      expect(screen.getByTitle(INDEX_STATE_COPY.PENDING.description)).toBeTruthy();
    });

    state = 'INDEXED';
    await vi.advanceTimersByTimeAsync(POLL_START_MS);

    await waitFor(() => {
      expect(screen.getByTitle(INDEX_STATE_COPY.INDEXED.description)).toBeTruthy();
    });
    expect(request).toHaveBeenLastCalledWith(LIST, firstPage);
  });
});

describe('mergeProducts', () => {
  it('replaces by id, keeps order, and never appends a row the screen did not have', () => {
    const merged = mergeProducts(
      [wine({ id: 'a', name: 'A' }), wine({ id: 'b', name: 'B' })],
      [wine({ id: 'b', name: 'B2' }), wine({ id: 'z', name: 'Nuovo altrove' })],
    );

    expect(merged.map((product) => product.name)).toEqual(['A', 'B2']);
  });
});

describe('the /catalogo route', () => {
  it('mounts the screen with a client for the active winery', async () => {
    globalThis.history.pushState({}, '', '/catalogo');
    const { client, request } = fakeClient({ [LIST]: () => Promise.resolve(listOf([])) });
    const clientFor = vi.fn(() => client);

    render(
      <Layout
        session={{
          status: 'signed-in',
          userId: 'user_matteo',
          memberships: [{ tenantId: TENANT, role: 'OWNER' }],
          active: { tenantId: TENANT, role: 'OWNER' },
        }}
        clientFor={clientFor}
      />,
    );

    expect(await screen.findByRole('searchbox')).toBeTruthy();
    expect(clientFor).toHaveBeenCalledWith(TENANT);
    expect(request).toHaveBeenCalledWith(LIST, firstPage);
  });
});
