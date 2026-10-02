import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { ApiClient, FunnelResponse, TopResponse } from '@catalogorosso/api-client';
import { MIN_QUERY_CONVERSATIONS } from '@catalogorosso/core/analytics-top';

import {
  count,
  day,
  DEFAULT_CHOICE,
  percent,
  RANGE_CHOICES,
  rangeOf,
  STAGE_LABELS,
  type RangeChoice,
} from './analytics-copy.js';

/**
 * Analisi (P6-02, §2.4): what visitors did with the sommelier, over a range
 * the seller picks.
 *
 * **Every number comes from the API, which counts it.** This screen formats;
 * it decides nothing — not what a stage is, not which visits reached it, not
 * what a day is. A panel that recomputed any of that would be a second
 * definition, and two definitions disagree on the day it matters.
 */

interface Range {
  readonly from: string;
  readonly to: string;
}

/** The funnel (P6-02): visits reaching each stage, and the share of each step. */
export const FunnelPanel = ({
  client,
  range,
}: {
  readonly client: ApiClient;
  readonly range: Range;
}): JSX.Element => {
  const [funnel, setFunnel] = useState<FunnelResponse | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;

    setFailed(false);
    client
      .request('GET /v1/dashboard/analytics/funnel', { query: { from: range.from, to: range.to } })
      .then((answer) => {
        if (live) setFunnel(answer);
      })
      .catch(() => {
        if (live) setFailed(true);
      });

    return () => {
      live = false;
    };
  }, [client, range.from, range.to]);

  if (failed) {
    return (
      <section class="cr-funnel" aria-label="Percorso dei visitatori">
        <h2>Percorso dei visitatori</h2>
        <p role="alert">Non è stato possibile leggere il percorso. Riprova fra un momento.</p>
      </section>
    );
  }

  if (funnel === undefined) {
    return (
      <section class="cr-funnel" aria-label="Percorso dei visitatori" aria-busy="true">
        <h2>Percorso dei visitatori</h2>
      </section>
    );
  }

  const first = funnel.stages[0]?.sessions ?? 0;

  return (
    <section class="cr-funnel" aria-label="Percorso dei visitatori">
      <h2>Percorso dei visitatori</h2>
      {first === 0 ? (
        <p>Nessuna visita ha aperto il sommelier in questo periodo.</p>
      ) : (
        <table>
          <caption>
            Dal {day(funnel.from)} al {day(funnel.to)}
          </caption>
          <thead>
            <tr>
              <th scope="col">Passo</th>
              <th scope="col">Visite</th>
              <th scope="col">Dal passo precedente</th>
            </tr>
          </thead>
          <tbody>
            {funnel.stages.map((step) => (
              <tr key={step.stage}>
                <th scope="row">{STAGE_LABELS[step.stage]}</th>
                <td>
                  {count(step.sessions)}
                  <meter
                    class="cr-funnel__bar"
                    min={0}
                    max={first}
                    value={step.sessions}
                    aria-hidden="true"
                  />
                </td>
                <td>{step.rate === null ? '—' : percent(step.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="cr-funnel__note">
        Le vendite si vedranno qui quando il negozio Shopify sarà collegato: fino ad allora contiamo
        le aggiunte al carrello, non gli ordini.
      </p>
    </section>
  );
};

/** One question, as a seller reads it: what was asked, by how many, and when last. */
const QueryRow = ({ query }: { readonly query: TopResponse['queries'][number] }): JSX.Element => (
  <tr>
    <th scope="row">{query.query}</th>
    <td>{count(query.conversations)}</td>
    <td>{day(query.lastAskedAt.slice(0, 10))}</td>
  </tr>
);

/** A wine's name, or what became of it: a recommendation is not undone by the catalogue. */
const wineName = (product: TopResponse['products'][number]): string => {
  if (product.name === null) return 'Vino non più in catalogo';

  return product.archived ? `${product.name} (archiviato)` : product.name;
};

/**
 * The questions most asked and the wines most recommended (P6-03, §2.4),
 * from one request over the funnel's range.
 */
export const TopPanels = ({
  client,
  range,
}: {
  readonly client: ApiClient;
  readonly range: Range;
}): JSX.Element => {
  const [top, setTop] = useState<TopResponse | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;

    setFailed(false);
    client
      .request('GET /v1/dashboard/analytics/top', { query: { from: range.from, to: range.to } })
      .then((answer) => {
        if (live) setTop(answer);
      })
      .catch(() => {
        if (live) setFailed(true);
      });

    return () => {
      live = false;
    };
  }, [client, range.from, range.to]);

  if (failed) {
    return (
      <section class="cr-top" aria-label="Domande e vini">
        <p role="alert">
          Non è stato possibile leggere domande e vini consigliati. Riprova fra un momento.
        </p>
      </section>
    );
  }

  if (top === undefined)
    return <section class="cr-top" aria-label="Domande e vini" aria-busy="true" />;

  return (
    <section class="cr-top" aria-label="Domande e vini">
      <section aria-label="Domande più frequenti">
        <h2>Domande più frequenti</h2>
        {top.queries.length === 0 ? (
          <p>
            Nessuna domanda è stata fatta in almeno {count(MIN_QUERY_CONVERSATIONS)} conversazioni
            in questo periodo.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Domanda</th>
                <th scope="col">Conversazioni</th>
                <th scope="col">Ultima volta</th>
              </tr>
            </thead>
            <tbody>
              {top.queries.map((query) => (
                <QueryRow key={query.query} query={query} />
              ))}
            </tbody>
          </table>
        )}
        <p class="cr-top__note">
          Mostriamo una domanda solo quando l&apos;hanno fatta almeno{' '}
          {count(MIN_QUERY_CONVERSATIONS)} conversazioni: così non compare mai ciò che un singolo
          visitatore ha scritto di sé.
        </p>
      </section>
      <section aria-label="Vini più consigliati">
        <h2>Vini più consigliati</h2>
        {top.products.length === 0 ? (
          <p>Il sommelier non ha consigliato nessun vino in questo periodo.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Vino</th>
                <th scope="col">Consigliato in</th>
                <th scope="col">Aggiunte al carrello</th>
                <th scope="col">Conversione</th>
              </tr>
            </thead>
            <tbody>
              {top.products.map((product) => (
                <tr key={product.productId}>
                  <th scope="row">{wineName(product)}</th>
                  <td>{count(product.recommended)}</td>
                  <td>{count(product.addedToCart)}</td>
                  <td>{percent(product.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
};

export const AnalyticsScreen = ({
  client,
  now = () => new Date(),
}: {
  readonly client: ApiClient;
  /** Today, injected so a test can say which days a choice means. */
  readonly now?: (() => Date) | undefined;
}): JSX.Element => {
  const [choice, setChoice] = useState<RangeChoice>(DEFAULT_CHOICE);
  const [range, setRange] = useState(() => rangeOf(DEFAULT_CHOICE, now()));

  return (
    <section class="cr-analytics">
      <h1>Analisi</h1>
      <label>
        Periodo{' '}
        <select
          value={String(choice)}
          onChange={(event: Event) => {
            const picked = Number((event.currentTarget as HTMLSelectElement).value) as RangeChoice;

            setChoice(picked);
            setRange(rangeOf(picked, now()));
          }}
        >
          {RANGE_CHOICES.map((days) => (
            <option key={days} value={String(days)}>
              Ultimi {days} giorni
            </option>
          ))}
        </select>
      </label>
      <FunnelPanel client={client} range={range} />
      <TopPanels client={client} range={range} />
    </section>
  );
};
