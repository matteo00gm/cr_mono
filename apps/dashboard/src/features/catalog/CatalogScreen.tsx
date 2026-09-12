import { ApiError, type ApiClient, type Product } from '@catalogorosso/api-client';
import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { CatalogGrid, type GridColumn, type GridRow } from './CatalogGrid.js';
import { CompletenessIndicator } from './CompletenessIndicator.js';
import {
  IndexFailureBanner,
  indexStatusColumn,
  settlingCount,
  useIndexPolling,
} from './IndexStatus.js';
import { formatCents } from './price.js';
import { describeFailure } from './request-failure.js';

/**
 * The catalogue screen (P1-10b).
 *
 * **Added to close a gap three rows left open.** P1-10's grid, P1-13's
 * completeness column and P1-40's index status each shipped as a component
 * with nothing mounting it, so a seller still could not see their own
 * catalogue. This is the page that composes them: the list, search, more rows,
 * each wine's index state and the catalogue-wide reindex.
 */

/** Rows per request. Two screens' worth; the grid virtualises whatever is loaded. */
export const PAGE_SIZE = 50;

/**
 * The most a background refresh asks for, which is the server's own ceiling
 * (P1-06).
 *
 * A seller who has scrolled past it sees those later rows keep the state they
 * last had until they reload or press Reindex on one. Asking for more would be
 * a request the API refuses, and paging through the whole list every few
 * seconds to keep a status dot current is not a cost worth paying.
 */
export const REFRESH_LIMIT = 100;

const STOCK_LABEL: Readonly<Record<Product['stockStatus'], string>> = {
  IN_STOCK: 'Disponibile',
  OUT_OF_STOCK: 'Esaurito',
  PREORDER: 'In prevendita',
};

/**
 * The rows on screen, with any the server sent back replaced by id.
 *
 * **Never appends and never reorders.** A background refresh runs while a
 * seller is reading, possibly with a pointer over a button; a wine created
 * elsewhere jumping into the middle of the list would move the row they were
 * about to press. New wines appear on the next search or reload, which is when
 * somebody expects the list to change.
 */
export const mergeProducts = (
  current: readonly Product[],
  fresh: readonly Product[],
): Product[] => {
  const byId = new Map(fresh.map((product) => [product.id, product]));
  return current.map((product) => byId.get(product.id) ?? product);
};

/** The screen's columns. Exported so a later row can swap a cell for an editor. */
export const catalogueColumns = (
  client: ApiClient,
  onReindexed: (product: Product) => void,
): readonly GridColumn<Product>[] => [
  { key: 'name', header: 'Nome', cell: (row) => row.data.name },
  { key: 'producer', header: 'Produttore', cell: (row) => row.data.producer ?? '—' },
  {
    key: 'vintage',
    header: 'Annata',
    width: '5rem',
    numeric: true,
    cell: (row) => row.data.vintage ?? '—',
  },
  {
    key: 'priceCents',
    header: 'Prezzo',
    width: '8rem',
    numeric: true,
    cell: (row) => `${formatCents(row.data.priceCents)} ${row.data.currency}`,
  },
  {
    key: 'stockStatus',
    header: 'Disponibilità',
    width: '8rem',
    cell: (row) => STOCK_LABEL[row.data.stockStatus],
  },
  {
    key: 'completeness',
    header: 'Completezza',
    width: '9rem',
    cell: (row) => <CompletenessIndicator product={row.data} variant="compact" />,
  },
  indexStatusColumn(client, onReindexed),
];

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly message: string };

const queuedNotice = (queued: number): string => {
  if (queued === 0) return 'Nessun vino attivo da reindicizzare.';
  if (queued === 1) return '1 vino in coda per la reindicizzazione.';
  return `${String(queued)} vini in coda per la reindicizzazione.`;
};

export const CatalogScreen = ({ client }: { readonly client: ApiClient }): JSX.Element => {
  const [products, setProducts] = useState<readonly Product[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [matchedBy, setMatchedBy] = useState<'exact' | 'similar' | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  /*
   * **Which answer is still wanted.** Every search, and unmounting, moves this
   * on; an answer carrying an older number is dropped. Without it a slow reply
   * to "barolo" landing after a fast one to "etna" would replace the list the
   * seller asked for with the one they abandoned — and nothing on screen would
   * say which search it was.
   */
  const generation = useRef(0);

  const fetchPage = (cursor: string | undefined, limit: number) =>
    client.request('GET /v1/dashboard/products', {
      query: { q: search === '' ? undefined : search, cursor, limit },
    });

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    setLoad({ status: 'loading' });

    void fetchPage(undefined, PAGE_SIZE).then(
      (page) => {
        if (mine !== generation.current) return;
        setProducts(page.items);
        setNextCursor(page.nextCursor);
        setMatchedBy(page.matchedBy);
        setLoad({ status: 'ready' });
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        setLoad({
          status: 'failed',
          message: describeFailure('Non è stato possibile caricare il catalogo.', error),
        });
      },
    );

    return () => {
      generation.current += 1;
    };
    /*
     * `client` is deliberately absent: the shell builds one per winery and
     * memoises it, and a caller that did not would otherwise refetch on every
     * render. Switching winery reloads the page (P0-57).
     */
  }, [search, attempt]);

  /*
   * Re-reads the rows already on screen and replaces them by id. A failed
   * refresh changes nothing — the rows are still true as of the last answer,
   * and the next tick tries again.
   */
  const refresh = (): void => {
    const mine = generation.current;
    const limit = Math.min(Math.max(products.length, PAGE_SIZE), REFRESH_LIMIT);

    void fetchPage(undefined, limit).then(
      (page) => {
        if (mine === generation.current) {
          setProducts((current) => mergeProducts(current, page.items));
        }
      },
      () => undefined,
    );
  };

  useIndexPolling(settlingCount(products), refresh);

  const replace = useCallback((product: Product) => {
    setProducts((current) => mergeProducts(current, [product]));
  }, []);

  const columns = useMemo(() => catalogueColumns(client, replace), [client, replace]);

  const rows = useMemo(
    () =>
      products.map((product): GridRow<Product> => ({
        id: product.id,
        data: product,
        state: 'saved',
      })),
    [products],
  );

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) return;
    const mine = generation.current;
    setLoadingMore(true);

    try {
      const page = await fetchPage(nextCursor, PAGE_SIZE);
      if (mine !== generation.current) return;
      setProducts((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (mine === generation.current) {
        setNotice(describeFailure('Non è stato possibile caricare altri vini.', error));
      }
    } finally {
      if (mine === generation.current) setLoadingMore(false);
    }
  };

  const reindexAll = async (): Promise<void> => {
    const mine = generation.current;
    setReindexing(true);
    setNotice(undefined);

    try {
      const answer = await client.request('POST /v1/dashboard/products/reindex-all');
      if (mine !== generation.current) return;
      setNotice(queuedNotice(answer.queued));
      // The states moved server-side; reading them back is what starts the poll.
      refresh();
    } catch (error) {
      if (mine !== generation.current) return;
      /*
       * A 409 is not a failure to report but a fact to state. The server's
       * message carries the remaining count, in English; parsing a number out
       * of prose would couple this screen to a sentence, so the count is left
       * to the index column, which already shows every settling wine.
       */
      setNotice(
        error instanceof ApiError && error.status === 409
          ? 'Una reindicizzazione del catalogo è già in corso. Attendi che finisca prima di avviarne un’altra.'
          : describeFailure('Reindicizzazione del catalogo non avviata. Riprova tra poco.', error),
      );
    } finally {
      if (mine === generation.current) setReindexing(false);
    }
  };

  const body = (): JSX.Element => {
    if (load.status === 'failed') {
      return (
        <div class="cr-banner cr-banner--danger" role="alert">
          <p>{load.message}</p>
          <button
            type="button"
            onClick={() => {
              setAttempt((count) => count + 1);
            }}
          >
            Riprova
          </button>
        </div>
      );
    }

    if (load.status === 'loading' && products.length === 0) {
      return (
        <p class="cr-catalog__loading" aria-busy="true">
          Caricamento del catalogo…
        </p>
      );
    }

    return (
      <>
        {matchedBy === 'similar' && (
          <p class="cr-catalog__hint" role="status">
            Nessuna corrispondenza esatta: ecco i vini più simili.
          </p>
        )}

        <CatalogGrid
          rows={rows}
          columns={columns}
          empty={search === '' ? undefined : 'Nessun vino corrisponde alla ricerca.'}
        />

        {nextCursor !== null && (
          <button
            type="button"
            class="cr-catalog__more"
            disabled={loadingMore}
            onClick={() => {
              void loadMore();
            }}
          >
            {loadingMore ? 'Caricamento…' : 'Carica altri vini'}
          </button>
        )}
      </>
    );
  };

  return (
    <section
      class="cr-catalog"
      aria-labelledby="catalog-title"
      aria-busy={load.status === 'loading'}
    >
      <header class="cr-catalog__header">
        <h1 id="catalog-title">Catalogo</h1>
        <button
          type="button"
          class="cr-catalog__reindex"
          disabled={reindexing}
          onClick={() => {
            void reindexAll();
          }}
        >
          {reindexing ? 'Avvio in corso…' : 'Reindicizza tutto il catalogo'}
        </button>
      </header>

      <form
        role="search"
        class="cr-catalog__search"
        onSubmit={(event: Event) => {
          event.preventDefault();
          setSearch(draft.trim());
        }}
      >
        <label for="catalog-search" class="cr-visually-hidden">
          Cerca nel catalogo
        </label>
        <input
          id="catalog-search"
          type="search"
          value={draft}
          maxLength={200}
          placeholder="Nome, produttore, SKU, vitigno, regione…"
          onInput={(event) => {
            setDraft(event.currentTarget.value);
          }}
        />
        <button type="submit">Cerca</button>
      </form>

      {notice !== undefined && (
        <p class="cr-catalog__notice" role="status">
          {notice}
        </p>
      )}

      <IndexFailureBanner products={products} />

      {body()}
    </section>
  );
};
