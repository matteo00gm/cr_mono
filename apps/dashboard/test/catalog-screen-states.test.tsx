import { ApiError } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CatalogScreen } from '../src/features/catalog/CatalogScreen.js';
import { INDEX_STATE_COPY, POLL_START_MS } from '../src/features/catalog/IndexStatus.js';
import { fakeClient, listOf } from './support/client.js';
import { wine } from './support/wine.js';

/**
 * The catalogue screen's in-between states (P1-10b).
 *
 * `catalog-screen.test.tsx` covers what the screen does; this covers what it
 * does *while* something is happening and *after* the seller has moved on —
 * the branches a coverage report showed nothing had taken. Each is a way to
 * show a seller something that is no longer true: a button that looks pressable
 * mid-request, rows from a list they abandoned, a notice about a reindex of a
 * page they have since replaced.
 */

const LIST = 'GET /v1/dashboard/products';
const REINDEX_ALL = 'POST /v1/dashboard/products/reindex-all';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const names = (): (string | null | undefined)[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('[role="gridcell"]')?.textContent);

const searchFor = (phrase: string) => {
  fireEvent.input(screen.getByRole('searchbox'), { target: { value: phrase } });
  fireEvent.submit(screen.getByRole('search'));
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A promise the test resolves or rejects by hand. */
const held = () => {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return {
    promise,
    resolve: (value: unknown) => {
      resolve(value);
    },
    reject: (error: unknown) => {
      reject(error);
    },
  };
};

describe('while a request is in flight', () => {
  it('says it is loading more rows, and cannot be pressed twice', async () => {
    const more = held();
    const { client } = fakeClient({
      [LIST]: (init) =>
        init?.query?.cursor === 'c1'
          ? more.promise
          : Promise.resolve(listOf([wine({ id: 'a', name: 'Primo' })], { nextCursor: 'c1' })),
    });

    render(<CatalogScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Carica altri vini' }));

    expect(await screen.findByRole('button', { name: 'Caricamento…' })).toHaveProperty(
      'disabled',
      true,
    );

    more.resolve(listOf([wine({ id: 'b', name: 'Secondo' })]));

    await waitFor(() => {
      expect(names()).toEqual(['Primo', 'Secondo']);
    });
  });

  it('says a catalogue reindex is starting, and cannot be pressed twice', async () => {
    const reindex = held();
    const { client } = fakeClient({
      [LIST]: () => Promise.resolve(listOf([wine()])),
      [REINDEX_ALL]: () => reindex.promise,
    });

    render(<CatalogScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reindicizza tutto il catalogo' }));

    expect(await screen.findByRole('button', { name: 'Avvio in corso…' })).toHaveProperty(
      'disabled',
      true,
    );

    reindex.resolve({ batchId: 'b', queued: 1 });

    expect(
      await screen.findByRole('button', { name: 'Reindicizza tutto il catalogo' }),
    ).toHaveProperty('disabled', false);
  });
});

describe('answers that arrive after the seller moved on', () => {
  it('ignores a failure for a search that has been replaced', async () => {
    const abandoned = held();
    const { client } = fakeClient({
      [LIST]: (init) => {
        const q = init?.query?.q;
        if (q === 'vecchia') return abandoned.promise;
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

    abandoned.reject(new ApiError(500, 'internal', 'boom', 'req_old'));
    await settle();

    // No failure banner for a list the seller is no longer looking at.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(names()).toEqual(['Nuova']);
  });

  it('does not append more rows to a list that has since been replaced', async () => {
    const more = held();
    const { client } = fakeClient({
      [LIST]: (init) => {
        if (init?.query?.cursor === 'c1') return more.promise;
        if (init?.query?.q === 'etna')
          return Promise.resolve(listOf([wine({ id: 'e', name: 'Etna' })]));
        return Promise.resolve(listOf([wine({ id: 'a', name: 'Primo' })], { nextCursor: 'c1' }));
      },
    });

    render(<CatalogScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Carica altri vini' }));

    searchFor('etna');
    await waitFor(() => {
      expect(names()).toEqual(['Etna']);
    });

    more.resolve(listOf([wine({ id: 'b', name: 'Secondo del vecchio elenco' })]));
    await settle();

    expect(names()).toEqual(['Etna']);
  });

  it('does not report a failure to load more for a list that has since been replaced', async () => {
    const more = held();
    const { client } = fakeClient({
      [LIST]: (init) => {
        if (init?.query?.cursor === 'c1') return more.promise;
        if (init?.query?.q === 'etna')
          return Promise.resolve(listOf([wine({ id: 'e', name: 'Etna' })]));
        return Promise.resolve(listOf([wine({ id: 'a', name: 'Primo' })], { nextCursor: 'c1' }));
      },
    });

    render(<CatalogScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Carica altri vini' }));
    searchFor('etna');
    await waitFor(() => {
      expect(names()).toEqual(['Etna']);
    });

    more.reject(new ApiError(500, 'internal', 'boom', 'req_more'));
    await settle();

    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each([
    [
      'succeeds',
      (reindex: ReturnType<typeof held>) => {
        reindex.resolve({ batchId: 'b', queued: 3 });
      },
    ],
    [
      'fails',
      (reindex: ReturnType<typeof held>) => {
        reindex.reject(new ApiError(500, 'internal', 'boom', 'req_r'));
      },
    ],
  ])(
    'says nothing when a catalogue reindex %s after the list was replaced',
    async (_case, finish) => {
      const reindex = held();
      const { client } = fakeClient({
        [LIST]: (init) =>
          Promise.resolve(
            listOf([wine({ id: 'x', name: init?.query?.q === 'etna' ? 'Etna' : 'Iniziale' })]),
          ),
        [REINDEX_ALL]: () => reindex.promise,
      });

      render(<CatalogScreen client={client} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Reindicizza tutto il catalogo' }));

      searchFor('etna');
      await waitFor(() => {
        expect(names()).toEqual(['Etna']);
      });

      finish(reindex);
      await settle();

      expect(screen.queryByRole('status')).toBeNull();
    },
  );

  it('keeps the rows it has when a background refresh fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const { client, request } = fakeClient({
      [LIST]: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(listOf([wine({ embeddingState: 'PENDING' })]))
          : Promise.reject(new ApiError(503, 'unavailable', 'down', 'req_refresh'));
      },
    });

    render(<CatalogScreen client={client} />);
    await waitFor(() => {
      expect(screen.getByTitle(INDEX_STATE_COPY.PENDING.description)).toBeTruthy();
    });

    await vi.advanceTimersByTimeAsync(POLL_START_MS);
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });

    // Still true as of the last answer; the next tick tries again.
    expect(screen.getByTitle(INDEX_STATE_COPY.PENDING.description)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the read-only cells', () => {
  it('shows a producer and a vintage when a wine has them, and a dash when it does not', async () => {
    const { client } = fakeClient({
      [LIST]: () =>
        Promise.resolve(
          listOf([
            wine({ id: 'a', name: 'Barolo', producer: 'Poderi Colla', vintage: 2019 }),
            wine({ id: 'b', name: 'Senza annata', producer: null, vintage: null }),
          ]),
        ),
    });

    render(<CatalogScreen client={client} />);
    await waitFor(() => {
      expect(names()).toEqual(['Barolo', 'Senza annata']);
    });

    const [first, second] = screen.getAllByRole('row').slice(1);
    const cells = (row: HTMLElement | undefined) =>
      [...(row?.querySelectorAll('[role="gridcell"]') ?? [])].map((cell) => cell.textContent);

    expect(cells(first).slice(1, 3)).toEqual(['Poderi Colla', '2019']);
    expect(cells(second).slice(1, 3)).toEqual(['—', '—']);
  });
});
