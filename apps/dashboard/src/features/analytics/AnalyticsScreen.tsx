import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { ApiClient, FunnelResponse } from '@catalogorosso/api-client';

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
    </section>
  );
};
