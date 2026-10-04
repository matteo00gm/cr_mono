import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { ApiError, type ApiClient, type ShopifyStatusResponse } from '@catalogorosso/api-client';

/**
 * Integrazioni (P6-06): connecting the winery's Shopify store.
 *
 * **The screen starts the install and reads how it ended; it decides neither.**
 * "Collega" asks the API for the store's consent URL and sends the owner
 * there; Shopify sends them back to the API, which checks everything and
 * returns them here with an outcome in the address. What the owner is told
 * for each outcome is the whole of this file's judgement.
 */

/** What the owner is told when Shopify sent them back, by the API's outcome. */
export const RETURN_NOTICES: Readonly<Record<string, string>> = {
  firma: 'La risposta di Shopify non era firmata correttamente. Riprova da qui.',
  stato: 'Questo collegamento è già stato usato, o non è stato avviato da te. Riprova da qui.',
  scaduto: 'Il collegamento è scaduto: hai dieci minuti per approvarlo su Shopify. Riprova.',
  negozio: 'Il negozio che ha risposto non è quello indicato. Riprova.',
  permessi: 'Il tuo ruolo non può collegare un negozio: chiedi a un titolare.',
  verifica: 'Attiva la verifica in due passaggi per collegare un negozio.',
  scambio: 'Shopify non ha confermato il collegamento. Riprova fra un momento.',
  ambiti:
    'Servono i permessi di lettura di prodotti e ordini: approvali tutti su Shopify e riprova.',
  occupato: 'Questo negozio è già collegato a un’altra cantina.',
  configurazione: 'Shopify non è ancora disponibile su questo servizio.',
};

/** What became of the shop's own myshopify.com address, after a completed install. */
export const DOMAIN_NOTICES: Readonly<Record<string, string>> = {
  verificato: 'Il suo indirizzo myshopify.com è ora uno dei tuoi domini verificati.',
  limite:
    'Il suo indirizzo myshopify.com non è stato aggiunto ai domini: il tuo piano non ne prevede altri.',
  occupato: 'Il suo indirizzo myshopify.com risulta già di un’altra cantina.',
};

/** The notice for a return address, or nothing for a visit that was not a return. */
export const returnNotice = (
  search: string,
): { readonly ok: boolean; readonly text: string } | undefined => {
  const params = new URLSearchParams(search);
  const outcome = params.get('shopify');

  if (outcome === 'collegato') {
    const domain = DOMAIN_NOTICES[params.get('dominio') ?? ''];

    return { ok: true, text: `Negozio collegato.${domain === undefined ? '' : ` ${domain}`}` };
  }

  if (outcome === 'errore') {
    return {
      ok: false,
      text:
        RETURN_NOTICES[params.get('motivo') ?? ''] ??
        'Il collegamento non è riuscito. Riprova fra un momento.',
    };
  }

  return undefined;
};

const day = (iso: string): string =>
  new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(iso),
  );

export const IntegrationsScreen = ({
  client,
  canConnect,
  search = globalThis.location.search,
  go = (url) => {
    globalThis.location.assign(url);
  },
}: {
  readonly client: ApiClient;
  /** Whether this member may connect a store (`domains:manage`). UX only: the API decides. */
  readonly canConnect: boolean;
  readonly search?: string | undefined;
  /** Where the install continues: Shopify's consent screen. Injected so a test can see it. */
  readonly go?: ((url: string) => void) | undefined;
}): JSX.Element => {
  const [status, setStatus] = useState<ShopifyStatusResponse | undefined>();
  const [failed, setFailed] = useState(false);
  const [shop, setShop] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>();
  const notice = returnNotice(search);

  useEffect(() => {
    let live = true;

    client
      .request('GET /v1/dashboard/shopify')
      .then((answer) => {
        if (live) setStatus(answer);
      })
      .catch(() => {
        if (live) setFailed(true);
      });

    return () => {
      live = false;
    };
  }, [client]);

  const connect = async (event: Event): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setRefusal(undefined);

    try {
      const { url } = await client.request('POST /v1/dashboard/shopify/install', {
        body: { shop },
      });

      go(url);
    } catch (error) {
      setRefusal(
        error instanceof ApiError
          ? error.message
          : 'Non è stato possibile avviare il collegamento. Riprova fra un momento.',
      );
      setBusy(false);
    }
  };

  const connected = status?.shop !== null && status?.shop.uninstalledAt === null;

  return (
    <section class="cr-integrations">
      <h1>Integrazioni</h1>
      {notice === undefined ? null : (
        <p role={notice.ok ? 'status' : 'alert'} class="cr-integrations__notice">
          {notice.text}
        </p>
      )}
      <section aria-label="Shopify">
        <h2>Shopify</h2>
        {failed ? (
          <p role="alert">Non è stato possibile leggere lo stato. Riprova fra un momento.</p>
        ) : status === undefined ? null : !status.configured ? (
          <p>Shopify non è ancora disponibile su questo servizio.</p>
        ) : (
          <>
            {status.shop === null ? (
              <p>
                Collega il tuo negozio Shopify: il sommelier leggerà il catalogo e gli ordini, e le
                vendite che consiglia compariranno nelle analisi.
              </p>
            ) : connected ? (
              <p>
                Collegato a <strong>{status.shop.shop}</strong> dal {day(status.shop.installedAt)}.
              </p>
            ) : (
              <p>
                L’app è stata disinstallata da <strong>{status.shop.shop}</strong> il{' '}
                {day(status.shop.uninstalledAt ?? status.shop.installedAt)}. Puoi collegarlo di
                nuovo.
              </p>
            )}
            {!canConnect || connected ? null : (
              <form
                onSubmit={(event: Event) => {
                  void connect(event);
                }}
              >
                <label>
                  Il tuo negozio Shopify{' '}
                  <input
                    name="shop"
                    value={shop}
                    placeholder="cantina-rossi.myshopify.com"
                    onInput={(event: Event) => {
                      setShop((event.currentTarget as HTMLInputElement).value);
                    }}
                  />
                </label>
                <button type="submit" disabled={busy || shop.trim() === ''}>
                  Collega Shopify
                </button>
                {refusal === undefined ? null : <p role="alert">{refusal}</p>}
              </form>
            )}
            {!canConnect && !connected ? (
              <p>Chiedi a un titolare di collegare il negozio.</p>
            ) : null}
          </>
        )}
      </section>
    </section>
  );
};
