import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { ApiError, type ApiClient, type KeysResponse } from '@catalogorosso/api-client';
import { installSnippet, LOADER_SRC } from '@catalogorosso/core/install-snippet';

import { StepUpPrompt } from '../security/StepUpPrompt.js';
import { needsStepUp, type TwoFactorApi } from '../security/two-factor.js';

/**
 * Widget (P4-09b, §2.1 step 6): what a seller pastes, and the keys behind it.
 *
 * **The rows built the keys and nobody could see them.** P4-08 and P4-09 put
 * issuing, rotating and the grace window in the API, and the screen that
 * shows a key, the snippet that carries it and the one moment a secret key is
 * readable never existed — so a winery could not install its own widget.
 *
 * **The snippet is the one `installSnippet` writes**, the function the Shopify
 * theme extension is held to (`theme-extension.test.ts`), so the tag here and
 * the tag a theme renders cannot disagree.
 *
 * **A secret key is on screen once.** The API returns it in the answer to the
 * call that made it and never again (P4-09); this holds it until the owner
 * says it is saved, and then forgets it. Nothing writes it anywhere.
 *
 * Every change is the owner's and asks for a fresh second factor (P4-11),
 * exactly as the billing screen does: the action, a prompt, the same action
 * again.
 */

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'none' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'keys'; readonly keys: KeysResponse };

/** A date and time as a seller reads one. */
const when = (iso: string): string =>
  new Date(iso).toLocaleString('it-IT', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });

export const COPIED = 'Copiato.';

/** Where the integration guides are published (P7-09). */
export const DOCS_SHOPIFY = '/docs/shopify.html';
export const DOCS_CUSTOM_SITE = '/docs/sito.html';

const CopyButton = ({
  text,
  label,
  copy,
}: {
  readonly text: string;
  readonly label: string;
  readonly copy: (text: string) => Promise<void>;
}): JSX.Element => {
  const [copied, setCopied] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void copy(text).then(
            () => {
              setCopied(true);
            },
            () => {
              setCopied(false);
            },
          );
        }}
      >
        {label}
      </button>
      {copied ? <span role="status">{COPIED}</span> : null}
    </>
  );
};

export const WidgetScreen = ({
  client,
  twoFactor,
  copy = (text) => globalThis.navigator.clipboard.writeText(text),
}: {
  readonly client: ApiClient;
  /** The step-up's verifier (P4-11). Injected so a test can be the authenticator. */
  readonly twoFactor?: TwoFactorApi | undefined;
  /** The clipboard. Injected so a test can see what was copied. */
  readonly copy?: ((text: string) => Promise<void>) | undefined;
}): JSX.Element => {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  /** A secret key just issued: on screen until the owner says it is saved. */
  const [secret, setSecret] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<(() => Promise<void>) | undefined>();

  useEffect(() => {
    let live = true;

    client.request('GET /v1/dashboard/keys').then(
      (keys) => {
        if (live) setLoad({ kind: 'keys', keys });
      },
      (error: unknown) => {
        if (!live) return;

        /* No keys yet is a winery that has not installed, not a fault. */
        if (error instanceof ApiError && error.status === 404) setLoad({ kind: 'none' });
        else if (error instanceof ApiError && error.status === 403) setLoad({ kind: 'forbidden' });
        else setLoad({ kind: 'failed' });
      },
    );

    return () => {
      live = false;
    };
  }, [client]);

  /** One action, a fresh second factor if the API asks for one, then the same action again. */
  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setFailure(undefined);

    try {
      await action();
    } catch (error) {
      if (needsStepUp(error)) {
        setRetry(() => action);
      } else {
        setFailure(
          error instanceof ApiError
            ? error.message
            : 'Non è stato possibile completare l’operazione. Riprova fra un momento.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const issue = async () => {
    const { secretKey, ...keys } = await client.request('POST /v1/dashboard/keys');

    setSecret(secretKey);
    setLoad({ kind: 'keys', keys });
  };

  const rotateSecret = async () => {
    const { secretKey, ...keys } = await client.request('POST /v1/dashboard/keys/secret/rotate');

    setSecret(secretKey);
    setLoad({ kind: 'keys', keys });
  };

  const rotatePublic = async () => {
    setLoad({ kind: 'keys', keys: await client.request('POST /v1/dashboard/keys/public/rotate') });
  };

  const stepUp =
    retry === undefined ? null : (
      <StepUpPrompt
        api={twoFactor}
        onVerified={() => {
          const again = retry;

          setRetry(undefined);
          void act(again);
        }}
        onCancel={() => {
          setRetry(undefined);
        }}
      />
    );

  const alert = failure === undefined ? null : <p role="alert">{failure}</p>;

  if (load.kind === 'loading') {
    return (
      <section>
        <h1>Widget</h1>
        <p aria-busy="true">Caricamento…</p>
      </section>
    );
  }

  if (load.kind === 'failed') {
    return (
      <section>
        <h1>Widget</h1>
        <p role="alert">Non è stato possibile leggere le chiavi. Riprova fra un momento.</p>
      </section>
    );
  }

  if (load.kind === 'forbidden') {
    return (
      <section>
        <h1>Widget</h1>
        <p>Solo un titolare può vedere le chiavi e il codice da incollare. Chiedi a un titolare.</p>
      </section>
    );
  }

  if (load.kind === 'none') {
    return (
      <section class="cr-widget">
        <h1>Widget</h1>
        <p>
          Per mettere il sommelier sul tuo sito servono due chiavi: una pubblica, che va nel codice
          del sito, e una segreta, che resta sul tuo server e serve solo per l’integrazione
          avanzata.
        </p>
        {alert}
        <button type="button" disabled={busy} onClick={() => void act(issue)}>
          Genera le chiavi
        </button>
        {stepUp}
      </section>
    );
  }

  const { keys } = load;
  const snippet = installSnippet(keys.publicKey, LOADER_SRC);

  return (
    <section class="cr-widget">
      <h1>Widget</h1>
      {alert}

      {secret === undefined ? null : (
        <section class="cr-widget__secret" aria-label="Chiave segreta appena creata">
          <h2>La tua chiave segreta</h2>
          <p>
            Copiala ora e conservala sul tuo server: <strong>non la mostreremo più</strong>. Non
            metterla mai nel codice del sito, dove chiunque può leggerla.
          </p>
          <pre>
            <code>{secret}</code>
          </pre>
          <CopyButton text={secret} label="Copia la chiave segreta" copy={copy} />
          <button
            type="button"
            onClick={() => {
              setSecret(undefined);
            }}
          >
            Ho salvato la chiave
          </button>
        </section>
      )}

      <section aria-label="Codice da incollare">
        <h2>Codice da incollare</h2>
        <p>
          Incollalo in ogni pagina del sito, prima di <code>{'</body>'}</code>. Il sommelier compare
          solo sui domini che hai verificato.
        </p>
        <pre>
          <code>{snippet}</code>
        </pre>
        <CopyButton text={snippet} label="Copia il codice" copy={copy} />
        <p>
          Su Shopify non serve incollare nulla: nel tema, <em>Personalizza</em> →{' '}
          <em>Incorporamenti app</em> → <em>Sommelier AI</em>, e inserisci la chiave pubblica.{' '}
          <a href={DOCS_SHOPIFY}>Guida per Shopify</a> ·{' '}
          <a href={DOCS_CUSTOM_SITE}>Guida per gli altri siti</a>
        </p>
      </section>

      <section aria-label="Chiave pubblica">
        <h2>Chiave pubblica</h2>
        <p>
          <code>{keys.publicKey}</code>
        </p>
        {keys.previous === null ? null : (
          <p role="note">
            La chiave precedente, <code>{keys.previous.publicKey}</code>, funziona ancora fino al{' '}
            {when(keys.previous.validUntil)}: aggiorna il codice sul sito prima di allora.
          </p>
        )}
        <p>
          Sostituiscila se pensi che qualcuno la stia usando su un sito non tuo. La vecchia resta
          valida per un giorno, il tempo di aggiornare il codice.
        </p>
        <button type="button" disabled={busy} onClick={() => void act(rotatePublic)}>
          Sostituisci la chiave pubblica
        </button>
      </section>

      <section aria-label="Chiave segreta">
        <h2>Chiave segreta</h2>
        <p>
          <code>
            {keys.secretKeyPrefix}…{keys.secretKeyLast4}
          </code>
        </p>
        <p>
          Serve solo se il tuo server crea le sessioni del sommelier (integrazione avanzata). Se la
          sostituisci, quella attuale smette di funzionare subito.
        </p>
        <button type="button" disabled={busy} onClick={() => void act(rotateSecret)}>
          Sostituisci la chiave segreta
        </button>
      </section>

      {stepUp}
    </section>
  );
};
