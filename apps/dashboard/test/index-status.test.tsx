import { ApiError, type ApiClient, type Product } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CatalogGrid, type GridRow } from '../src/features/catalog/CatalogGrid.js';
import {
  INDEX_STATE_COPY,
  IndexFailureBanner,
  IndexStatusCell,
  indexStatusColumn,
  POLL_MAX_MS,
  POLL_START_MS,
  settlingCount,
  useIndexPolling,
} from '../src/features/catalog/IndexStatus.js';
import { wine } from './support/wine.js';

/**
 * The index-status column, its Reindex action and the failure banner (P1-40).
 *
 * **The polling is where the cost is**, so it is tested by the clock rather
 * than by reading the code: a poll that never backs off, never stops, or keeps
 * going in a hidden tab is a steady stream of list queries that no other test
 * would notice.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
});

const rowOf = (data: Product, state: GridRow<Product>['state'] = 'saved'): GridRow<Product> => ({
  id: data.id,
  data,
  state,
});

/** A client whose reindex answers however the test wants. */
const clientAnswering = (answer: () => Promise<unknown>) => {
  const request = vi.fn(answer);
  return { client: { request } as unknown as ApiClient, request };
};

/** A client whose answer the test releases by hand. */
const clientHeld = () => {
  let release: (value: unknown) => void = () => undefined;
  const held = clientAnswering(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );

  return {
    ...held,
    release: (value: unknown) => {
      release(value);
    },
  };
};

describe('each state', () => {
  it.each(Object.keys(INDEX_STATE_COPY) as Product['embeddingState'][])(
    'renders %s with its label and its meaning',
    (state) => {
      const { client } = clientAnswering(() => Promise.resolve({}));
      render(
        <IndexStatusCell
          row={rowOf(wine({ embeddingState: state }))}
          client={client}
          onReindexed={vi.fn()}
        />,
      );

      const label = screen.getByTitle(INDEX_STATE_COPY[state].description);

      expect(label.textContent).toContain(INDEX_STATE_COPY[state].label);
      // The hidden half is what a screen reader reads with the cell.
      expect(label.textContent).toContain(INDEX_STATE_COPY[state].description);
    },
  );

  it('tells a seller a failed wine is not being recommended, and what to do', () => {
    /*
     * The tooltip the row asks for, as built: the consequence and the action,
     * not the provider's error name — which is withheld until P1-50 turns it
     * into something a winery can act on.
     */
    const { description } = INDEX_STATE_COPY.FAILED;

    expect(description).toMatch(/non viene consigliato/);
    expect(description).toMatch(/Reindicizza/);
  });

  it('does not tell a seller an edited wine went offline', () => {
    // `STALE` is still recommended. Saying otherwise after every edit trains
    // people to stop editing.
    expect(INDEX_STATE_COPY.STALE.description).toMatch(/continua a essere consigliato/);
    expect(INDEX_STATE_COPY.PENDING.description).toMatch(/non può ancora essere consigliato/);
  });
});

describe('the Reindex action', () => {
  it('calls the endpoint for this wine and hands the grid the answer', async () => {
    const next = wine({ embeddingState: 'STALE' });
    const { client, request } = clientAnswering(() =>
      Promise.resolve({ product: next, queued: true }),
    );
    const onReindexed = vi.fn();

    render(<IndexStatusCell row={rowOf(wine())} client={client} onReindexed={onReindexed} />);

    // Named for the wine, so twenty rows are twenty distinguishable buttons.
    fireEvent.click(screen.getByRole('button', { name: /Barolo Bussia/ }));

    await waitFor(() => {
      expect(onReindexed).toHaveBeenCalledWith(next);
    });
    expect(request).toHaveBeenCalledWith('POST /v1/dashboard/products/:id/reindex', {
      params: { id: 'p1' },
    });
  });

  it('is disabled while its request is in flight, and not after', async () => {
    const { client, release } = clientHeld();

    render(<IndexStatusCell row={rowOf(wine())} client={client} onReindexed={vi.fn()} />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => {
      expect(button).toHaveProperty('disabled', true);
    });
    expect(button.textContent).toContain('In corso');

    release({ product: wine({ embeddingState: 'STALE' }), queued: true });

    await waitFor(() => {
      expect(button).toHaveProperty('disabled', false);
    });
    expect(button.textContent).toContain('Reindicizza');
  });

  it('is not offered on a row the server does not have, or on an archived wine', () => {
    /*
     * A draft has no id to send, and an archived wine has no vector to rebuild
     * — the API refuses it. A button that can only fail teaches people to stop
     * pressing the one that works.
     */
    const { client } = clientAnswering(() => Promise.resolve({}));

    for (const state of ['draft', 'error'] as const) {
      const { unmount } = render(
        <IndexStatusCell row={rowOf(wine(), state)} client={client} onReindexed={vi.fn()} />,
      );
      expect(screen.queryByRole('button'), state).toBeNull();
      unmount();
    }

    render(
      <IndexStatusCell
        row={rowOf(wine({ status: 'ARCHIVED' }))}
        client={client}
        onReindexed={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says it did not start, with the request id to quote', async () => {
    const { client } = clientAnswering(() =>
      Promise.reject(new ApiError(500, 'internal', 'Internal error', 'req_abc123')),
    );
    const onReindexed = vi.fn();

    render(<IndexStatusCell row={rowOf(wine())} client={client} onReindexed={onReindexed} />);

    fireEvent.click(screen.getByRole('button'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/non avviata/);
    expect(alert.textContent).toContain('req_abc123');
    // Never the server's own English message: P0-55 makes that the API
    // contract, not the interface copy.
    expect(alert.textContent).not.toContain('Internal error');
    expect(onReindexed).not.toHaveBeenCalled();
  });

  it.each([
    ['a network failure', new TypeError('Failed to fetch')],
    // The client's placeholder when the body carried no id. "Codice unknown" is
    // a support conversation that goes nowhere.
    ['a server answer with no id', new ApiError(502, 'unknown', 'Bad gateway', 'unknown')],
  ] as const)('does not quote a request id it was never given: %s', async (_label, error) => {
    const { client } = clientAnswering(() => Promise.reject(error));

    render(<IndexStatusCell row={rowOf(wine())} client={client} onReindexed={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/non avviata/);
    expect(alert.textContent).not.toMatch(/codice/);
  });

  it('clears an earlier failure when it tries again', async () => {
    let attempt = 0;
    const { client } = clientAnswering(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve({ product: wine({ embeddingState: 'STALE' }), queued: true });
    });

    render(<IndexStatusCell row={rowOf(wine())} client={client} onReindexed={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('still hands the answer over when the row scrolled away mid-request', async () => {
    /*
     * A virtualised row unmounts when it leaves the viewport. The answer
     * belongs to the grid, not the cell — dropping it would leave the row
     * showing its old state when it scrolls back.
     */
    const { client, release } = clientHeld();
    const onReindexed = vi.fn();
    const next = wine({ embeddingState: 'STALE' });

    const { unmount } = render(
      <IndexStatusCell row={rowOf(wine())} client={client} onReindexed={onReindexed} />,
    );

    fireEvent.click(screen.getByRole('button'));
    unmount();
    release({ product: next, queued: true });

    await waitFor(() => {
      expect(onReindexed).toHaveBeenCalledWith(next);
    });
  });

  it('sits in the grid as a column', () => {
    const { client } = clientAnswering(() => Promise.resolve({}));

    render(
      <CatalogGrid
        rows={[rowOf(wine({ embeddingState: 'FAILED' }))]}
        columns={[indexStatusColumn(client, vi.fn())]}
      />,
    );

    expect(screen.getByRole('columnheader').textContent).toBe('Indicizzazione');
    expect(screen.getByTitle(INDEX_STATE_COPY.FAILED.description)).toBeTruthy();
  });
});

describe('the failure banner', () => {
  it('is absent when nothing failed', () => {
    const { container } = render(
      <IndexFailureBanner
        products={[wine(), wine({ embeddingState: 'PENDING' }), wine({ embeddingState: 'STALE' })]}
      />,
    );

    expect(container.textContent).toBe('');
  });

  it('counts the failures, in words that agree with the number', () => {
    const { unmount } = render(
      <IndexFailureBanner products={[wine({ embeddingState: 'FAILED' }), wine()]} />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/^1 vino .* non è indicizzato/);
    unmount();

    render(
      <IndexFailureBanner
        products={[wine({ embeddingState: 'FAILED' }), wine({ embeddingState: 'FAILED' })]}
      />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/^2 vini .* non sono indicizzati/);
  });

  it('claims only the wines it was shown', () => {
    // The list is paginated with no total (P1-06); a catalogue-wide claim
    // would be a number the seller acts on and this cannot back.
    render(<IndexFailureBanner products={[wine({ embeddingState: 'FAILED' })]} />);

    expect(screen.getByRole('alert').textContent).toContain('tra quelli mostrati');
  });
});

describe('polling', () => {
  const Probe = ({
    settling,
    refresh,
  }: {
    readonly settling: number;
    readonly refresh: () => void;
  }) => {
    useIndexPolling(settling, refresh);
    return null;
  };

  it('counts the states the worker moves on its own, and only those', () => {
    expect(
      settlingCount([
        wine({ embeddingState: 'PENDING' }),
        wine({ embeddingState: 'STALE' }),
        wine({ embeddingState: 'INDEXED' }),
        wine({ embeddingState: 'FAILED' }),
      ]),
    ).toBe(2);
  });

  it('does nothing when nothing is settling', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();

    render(<Probe settling={0} refresh={refresh} />);
    vi.advanceTimersByTime(POLL_MAX_MS * 5);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('backs off, and stops backing off at a minute', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();

    render(<Probe settling={1} refresh={refresh} />);

    vi.advanceTimersByTime(POLL_START_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The second waits twice as long, not the same again.
    vi.advanceTimersByTime(POLL_START_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_START_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    // Well past the cap: one call per minute from here — never slower.
    vi.advanceTimersByTime(POLL_MAX_MS * 10);
    const before = refresh.mock.calls.length;
    vi.advanceTimersByTime(POLL_MAX_MS);
    expect(refresh.mock.calls.length).toBe(before + 1);
  });

  it('stops when everything has settled', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();

    const { rerender } = render(<Probe settling={2} refresh={refresh} />);
    vi.advanceTimersByTime(POLL_START_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(<Probe settling={0} refresh={refresh} />);
    vi.advanceTimersByTime(POLL_MAX_MS * 5);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('starts over quickly when there is something new to watch', () => {
    /*
     * A seller who presses Reindex after a long wait should see the result in
     * seconds, not after the minute the backoff had reached.
     */
    vi.useFakeTimers();
    const refresh = vi.fn();

    const { rerender } = render(<Probe settling={1} refresh={refresh} />);
    vi.advanceTimersByTime(POLL_MAX_MS * 5);
    const before = refresh.mock.calls.length;

    rerender(<Probe settling={2} refresh={refresh} />);
    vi.advanceTimersByTime(POLL_START_MS);

    expect(refresh.mock.calls.length).toBe(before + 1);
  });

  it('neither fetches nor backs off in a hidden tab', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });

    render(<Probe settling={1} refresh={refresh} />);
    vi.advanceTimersByTime(POLL_MAX_MS * 5);
    expect(refresh).not.toHaveBeenCalled();

    // Back in view: the next refresh is one short interval away, not a minute.
    Reflect.deleteProperty(document, 'visibilityState');
    vi.advanceTimersByTime(POLL_START_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('calls the latest refresh, not the one from the first render', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = render(<Probe settling={1} refresh={first} />);
    rerender(<Probe settling={1} refresh={second} />);
    vi.advanceTimersByTime(POLL_START_MS);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
