import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';

import { ApiError, type ApiClient, type RefusedOriginsResponse } from '@catalogorosso/api-client';

import { count, day } from './analytics-copy.js';

/**
 * Siti non autorizzati (P6-05, §3.2): the sites that tried to use this
 * winery's widget and were refused.
 *
 * **It leads with the fix.** A new domain, a `www` that was never added, a
 * shop moved to a new address — a misconfiguration is far more likely than
 * somebody copying the widget, and a panel that opened with "theft" would
 * frighten a seller out of the one click that solves it.
 *
 * **The click is the ordinary one.** "È mio, aggiungilo" posts to
 * `POST /domains`, the route the domains screen uses, with its capability
 * and its verification: the origin comes back `PENDING` with a record to
 * publish, and the widget keeps refusing it until that is done. Nothing here
 * can make a site trusted. Shown to those who may add a domain; the server
 * decides either way.
 */

type Refused = RefusedOriginsResponse['origins'][number];

/** Only a web address can be added; a sandboxed frame sends the string `null`. */
const addable = (origin: string): boolean => /^https?:\/\//u.test(origin);

const OriginAction = ({
  refused,
  status,
  failure,
  busy,
  canAdd,
  onAdd,
}: {
  readonly refused: Refused;
  readonly status: 'PENDING' | 'VERIFIED' | null;
  readonly failure: string | undefined;
  readonly busy: boolean;
  readonly canAdd: boolean;
  readonly onAdd: () => void;
}): JSX.Element => {
  if (status === 'VERIFIED') return <span>Verificato</span>;

  if (status === 'PENDING') {
    return (
      <span>
        Aggiunto, in attesa di verifica. <Link href="/domini">Completa la verifica</Link>
      </span>
    );
  }

  if (!addable(refused.origin)) return <span>Non è un sito che si possa aggiungere</span>;

  if (!canAdd) return <span>Se è vostro, chiedi a un titolare di aggiungerlo</span>;

  return (
    <span>
      <button type="button" disabled={busy} onClick={onAdd}>
        È mio, aggiungilo
      </button>
      {failure === undefined ? null : <span role="alert"> {failure}</span>}
    </span>
  );
};

export const RefusedOriginsPanel = ({
  client,
  range,
  canAdd,
}: {
  readonly client: ApiClient;
  readonly range: { readonly from: string; readonly to: string };
  /** Whether this member may add a domain (`domains:manage`). UX only: the route decides. */
  readonly canAdd: boolean;
}): JSX.Element => {
  const [answer, setAnswer] = useState<RefusedOriginsResponse | undefined>();
  const [failed, setFailed] = useState(false);
  const [added, setAdded] = useState<ReadonlyMap<string, 'PENDING' | 'VERIFIED'>>(new Map());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState<string | undefined>();

  useEffect(() => {
    let live = true;

    setFailed(false);
    client
      .request('GET /v1/dashboard/analytics/origins', {
        query: { from: range.from, to: range.to },
      })
      .then((read) => {
        if (live) setAnswer(read);
      })
      .catch(() => {
        if (live) setFailed(true);
      });

    return () => {
      live = false;
    };
  }, [client, range.from, range.to]);

  const add = async (origin: string): Promise<void> => {
    setBusy(origin);

    try {
      const { domain } = await client.request('POST /v1/dashboard/domains', {
        body: { domain: origin, kind: 'production' },
      });

      setAdded((before) => new Map(before).set(origin, domain.status));
    } catch (error) {
      /* The API's own words: a domain another winery holds, a plan's limit, a second factor. */
      const said =
        error instanceof ApiError
          ? error.message
          : 'Non è stato possibile aggiungerlo. Riprova fra un momento.';

      setFailures((before) => new Map(before).set(origin, said));
    } finally {
      setBusy(undefined);
    }
  };

  if (failed) {
    return (
      <section class="cr-origins" aria-label="Siti non autorizzati">
        <h2>Siti non autorizzati</h2>
        <p role="alert">Non è stato possibile leggere i siti rifiutati. Riprova fra un momento.</p>
      </section>
    );
  }

  if (answer === undefined) {
    return <section class="cr-origins" aria-label="Siti non autorizzati" aria-busy="true" />;
  }

  return (
    <section class="cr-origins" aria-label="Siti non autorizzati">
      <h2>Siti non autorizzati</h2>
      {answer.origins.length === 0 ? (
        <p>Nessun sito non autorizzato ha provato a usare il widget in questo periodo.</p>
      ) : (
        <>
          <p>
            Hai cambiato dominio o aperto un nuovo sito? Se uno di questi è tuo, aggiungilo: passerà
            dalla normale verifica, e da lì il widget risponderà. Se non lo riconosci, non serve
            fare nulla: da quel sito il widget non risponde.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Sito</th>
                <th scope="col">Tentativi</th>
                <th scope="col">Visitatori</th>
                <th scope="col">Ultima volta</th>
                <th scope="col">
                  <span class="cr-visually-hidden">Azione</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {answer.origins.map((refused) => (
                <tr key={refused.origin}>
                  <th scope="row">{refused.origin}</th>
                  <td>{count(refused.attempts)}</td>
                  <td>{count(refused.sources)}</td>
                  <td>{day(refused.lastSeenAt.slice(0, 10))}</td>
                  <td>
                    <OriginAction
                      refused={refused}
                      status={added.get(refused.origin) ?? refused.domain}
                      failure={failures.get(refused.origin)}
                      busy={busy === refused.origin}
                      canAdd={canAdd}
                      onAdd={() => {
                        void add(refused.origin);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
};
