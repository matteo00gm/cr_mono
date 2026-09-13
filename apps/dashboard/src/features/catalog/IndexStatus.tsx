import type { ApiClient, Product } from '@catalogorosso/api-client';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { GridColumn, GridRow } from './CatalogGrid.js';
import { describeFailure } from './request-failure.js';

/**
 * Whether a wine can be recommended yet, and a way to ask again (P1-40).
 *
 * **A wine that is not indexed is invisible in the widget and nowhere else.**
 * The seller sees it in their catalogue, a visitor never hears of it, and
 * nothing anywhere says why. This column is the only place that gap shows, so
 * it has to be loud where it matters — `FAILED` — and quiet where it does not.
 *
 * **The provider's reason is not shown, deliberately.** `embeddingError` holds
 * an error *name* ("ValidationException"), which tells a winery nothing it can
 * act on, and `product-contracts.test.ts` withholds it from the response until
 * P1-50 replaces it with a sentence that does. The tooltip therefore explains
 * what each state *means for the seller*, which is true today and stays true
 * once a reason sits beside it.
 */

type EmbeddingState = Product['embeddingState'];

interface StateCopy {
  readonly label: string;
  readonly description: string;
}

/**
 * Keyed by the response enum, so a state added to the contract is a compile
 * error here rather than a blank cell.
 */
export const INDEX_STATE_COPY: Readonly<Record<EmbeddingState, StateCopy>> = {
  INDEXED: {
    label: 'Indicizzato',
    description: 'Questo vino può essere consigliato ai visitatori.',
  },
  /*
   * Not "In attesa", and the difference is the reason P1-38 has two states: a
   * `STALE` wine is still recommended, under its previous description. Telling
   * a seller it is waiting would suggest an ordinary edit took it offline.
   */
  STALE: {
    label: 'In aggiornamento',
    description:
      'Stiamo elaborando le ultime modifiche. Nel frattempo il vino continua a essere consigliato con la descrizione precedente.',
  },
  PENDING: {
    label: 'In attesa',
    description: 'Il vino non è ancora indicizzato e non può ancora essere consigliato.',
  },
  FAILED: {
    label: 'Non indicizzato',
    description:
      'L’indicizzazione non è riuscita, quindi questo vino non viene consigliato. Usa «Reindicizza» per riprovare.',
  },
};

/** The states the worker will move on its own, so a refetch can show progress. */
const SETTLING: ReadonlySet<EmbeddingState> = new Set(['PENDING', 'STALE']);

export const settlingCount = (products: readonly Pick<Product, 'embeddingState'>[]): number =>
  products.filter((product) => SETTLING.has(product.embeddingState)).length;

export const POLL_START_MS = 3_000;
export const POLL_MAX_MS = 60_000;

/**
 * Refetches while any wine is still settling, backing off as it waits.
 *
 * **`STALE` counts as well as `PENDING`**, which the row does not ask for:
 * reindexing an `INDEXED` wine makes it `STALE`, and a poll that ignored that
 * would leave the button's own result on screen until a reload.
 *
 * **Backoff rather than a fixed interval, because one state never settles by
 * itself.** A wine whose outbox row was lost stays `PENDING` until somebody
 * presses Reindex; a fixed five-second poll would spend 720 list queries an
 * hour per open tab waiting for it. The delay doubles to a minute and starts
 * over whenever the number of settling wines changes — which is exactly when
 * there is something new to watch.
 *
 * A hidden tab neither fetches nor backs off: nobody is looking, and whoever
 * comes back should not wait a minute for the next refresh.
 */
export const useIndexPolling = (settling: number, refresh: () => void): void => {
  /*
   * The latest callback, read at tick time. A caller passing an inline closure
   * hands a new function every render, and restarting the timer for each one
   * would reset the backoff on every paint.
   */
  const latest = useRef(refresh);
  latest.current = refresh;

  useEffect(() => {
    if (settling === 0) return undefined;

    let delay = POLL_START_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = (): void => {
      if (document.visibilityState !== 'hidden') {
        latest.current();
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }

      timer = setTimeout(tick, delay);
    };

    timer = setTimeout(tick, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [settling]);
};

/** What the seller is told when the request itself failed; see `describeFailure`. */
const failureText = (error: unknown): string =>
  describeFailure('Reindicizzazione non avviata. Riprova tra poco.', error);

export interface IndexStatusCellProps {
  readonly row: GridRow<Product>;
  readonly client: ApiClient;
  /** Receives the server's copy of the wine, so the grid shows the real transition. */
  readonly onReindexed: (product: Product) => void;
}

export const IndexStatusCell = ({
  row,
  client,
  onReindexed,
}: IndexStatusCellProps): JSX.Element => {
  const product = row.data;
  const copy = INDEX_STATE_COPY[product.embeddingState];

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  /*
   * A virtualised row unmounts when it scrolls out of view, which can happen
   * while its request is in flight. Local state is then gone and must not be
   * set — but the answer still belongs to the grid, so `onReindexed` runs
   * either way.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /*
   * Only a saved, active wine. A draft has no id on the server yet, and an
   * archived wine has no vector to rebuild — the API refuses it, and a button
   * that always fails is worse than none.
   */
  const actionable = row.state === 'saved' && product.status === 'ACTIVE';

  const reindex = async (): Promise<void> => {
    setBusy(true);
    setFailure(undefined);

    try {
      const answer = await client.request('POST /v1/dashboard/products/:id/reindex', {
        params: { id: product.id },
      });
      onReindexed(answer.product);
    } catch (error) {
      if (mounted.current) setFailure(failureText(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <span class={`cr-index cr-index--${product.embeddingState.toLowerCase()}`}>
      {/*
       * The description twice, for two audiences. `title` is the tooltip a
       * pointer shows; the hidden text is what a screen reader reads with the
       * cell. A popover would be clipped by the grid's scrolling viewport, and
       * everything a seller must know is also in the banner above it.
       */}
      <span class="cr-index__state" title={copy.description}>
        {copy.label}
        <span class="cr-visually-hidden">{`. ${copy.description}`}</span>
      </span>

      {actionable && (
        <button
          type="button"
          class="cr-index__action"
          disabled={busy}
          onClick={() => {
            void reindex();
          }}
        >
          {busy ? 'In corso…' : 'Reindicizza'}{' '}
          {/* Twenty buttons all named "Reindicizza" are indistinguishable to a screen reader. */}
          <span class="cr-visually-hidden">{product.name}</span>
        </button>
      )}

      {failure !== undefined && (
        <span class="cr-grid__error" role="alert" title={failure}>
          {failure}
        </span>
      )}
    </span>
  );
};

/** The column, ready to hand to `CatalogGrid`. */
export const indexStatusColumn = (
  client: ApiClient,
  onReindexed: (product: Product) => void,
): GridColumn<Product> => ({
  key: 'embeddingState',
  header: 'Indicizzazione',
  width: '18rem',
  cell: (row) => <IndexStatusCell row={row} client={client} onReindexed={onReindexed} />,
});

/**
 * The loud part.
 *
 * **It counts the wines it was given and says so.** The catalogue is
 * keyset-paginated with no total (P1-06), so this cannot know how many failed
 * across the whole catalogue — and a banner claiming "3 wines" when the
 * seller has forty would be a number they act on. "Tra quelli mostrati" is the
 * honest scope.
 */
export const IndexFailureBanner = ({
  products,
}: {
  readonly products: readonly Pick<Product, 'embeddingState'>[];
}): JSX.Element | null => {
  const failed = products.filter((product) => product.embeddingState === 'FAILED').length;

  if (failed === 0) return null;

  return (
    <div class="cr-banner cr-banner--danger" role="alert">
      <strong>
        {failed === 1
          ? '1 vino tra quelli mostrati non è indicizzato e non viene consigliato ai visitatori.'
          : `${String(failed)} vini tra quelli mostrati non sono indicizzati e non vengono consigliati ai visitatori.`}
      </strong>{' '}
      Usa «Reindicizza» sulla riga per riprovare.
    </div>
  );
};
