import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';

import {
  ApiError,
  type ApiClient,
  type RagAnswerResponse,
  type RagSimulationResponse,
} from '@catalogorosso/api-client';

/**
 * Prova il sommelier (P2-37, P2-37b): a question, what the catalogue found for
 * it, and — only when asked — what the sommelier would answer.
 *
 * **Two buttons, because they cost different things.** Searching the catalogue
 * is free, moves no counter and can be run all afternoon; the answer is a real
 * model call, billed as one of the winery's messages. The second button says so
 * on its face, and nothing else on the screen asks for an answer: not the
 * search, not Enter, not a result arriving.
 *
 * **A refusal is shown in the API's own words** (P6-12): the month used up,
 * the widget not being served, ten a minute. Each already says what to do.
 *
 * Text nodes only. A reply is a model's words and a wine's name is a seller's;
 * neither is ever markup.
 */

type Candidate = RagSimulationResponse['candidates'][number];

/** Why a wine the search found did not reach the sommelier, in a seller's words. */
export const EXCLUDED: Readonly<Record<NonNullable<Candidate['excludedBy']>, string>> = {
  stock: 'non disponibile',
  price: 'oltre il prezzo indicato',
  cap: 'trovato, ma dopo i primi: il sommelier ne legge solo alcuni',
};

/** Why a search came back with nothing to recommend. */
export const NOTHING_FOUND: Readonly<
  Record<NonNullable<RagSimulationResponse['zeroResultKind']>, string>
> = {
  no_matches: 'Nel catalogo non c’è niente che risponda a questa domanda.',
  filtered_out: 'Qualcosa è stato trovato, ma niente che si possa proporre.',
  out_of_stock_only: 'I vini adatti ci sono, ma sono tutti esauriti.',
};

/** What a turn that ended without wines is put down to. */
export const ENDED: Readonly<Record<RagAnswerResponse['outcome'], string | undefined>> = {
  ok: undefined,
  repaired: undefined,
  schema_failed: 'Il sommelier ha risposto senza indicare vini in modo leggibile.',
  refusal: 'Il sommelier ha preferito non rispondere a questa domanda.',
  provider_error: 'Il modello non ha risposto. Il messaggio è stato comunque contato.',
};

export const ANSWER_BUTTON = 'Chiedi la risposta al sommelier (conta come 1 messaggio)';

const SEARCH_FAILED = 'La ricerca non è riuscita. Riprova fra un momento.';
const ANSWER_FAILED = 'La risposta non è arrivata. Riprova fra un momento.';

const said = (error: unknown, otherwise: string): string =>
  error instanceof ApiError ? error.message : otherwise;

export const SandboxScreen = ({ client }: { readonly client: ApiClient }): JSX.Element => {
  const [question, setQuestion] = useState('');
  const [found, setFound] = useState<RagSimulationResponse | undefined>();
  const [answer, setAnswer] = useState<RagAnswerResponse | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState<'search' | 'answer' | undefined>();
  /* Which question the screen is showing results for: a late answer to an old one is dropped. */
  const asked = useRef(0);

  const query = question.trim();

  const edit = (value: string): void => {
    /* What is on screen was about the old question, and would be read as about the new one. */
    asked.current += 1;
    setQuestion(value);
    setFound(undefined);
    setAnswer(undefined);
    setFailure(undefined);
  };

  const search = async (event: Event): Promise<void> => {
    event.preventDefault();

    if (query === '' || busy !== undefined) return;

    const mine = asked.current;

    setBusy('search');
    setFailure(undefined);

    try {
      const result = await client.request('POST /v1/dashboard/rag/simulate', { body: { query } });

      if (mine === asked.current) setFound(result);
    } catch (error) {
      if (mine === asked.current) setFailure(said(error, SEARCH_FAILED));
    } finally {
      setBusy(undefined);
    }
  };

  const ask = async (): Promise<void> => {
    /*
     * **One at a time, and never for nothing — checked here, not only by the
     * button being disabled.** A click that is dispatched rather than made
     * still reaches this handler on a disabled button, and here a second one
     * is a second message on the winery's bill.
     */
    if (query === '' || busy !== undefined) return;

    const mine = asked.current;

    setBusy('answer');
    setFailure(undefined);

    try {
      const result = await client.request('POST /v1/dashboard/rag/answer', { body: { query } });

      if (mine === asked.current) setAnswer(result);
    } catch (error) {
      if (mine === asked.current) setFailure(said(error, ANSWER_FAILED));
    } finally {
      setBusy(undefined);
    }
  };

  const ended = answer === undefined ? undefined : ENDED[answer.outcome];

  return (
    <section class="sandbox">
      <h1>Prova il sommelier</h1>
      <p>
        Scrivi una domanda come la farebbe un cliente. Cercare nel catalogo è gratuito e non entra
        nelle statistiche; la risposta del sommelier, se la chiedi, conta come un messaggio del tuo
        piano.
      </p>

      <form
        onSubmit={(event: Event) => {
          void search(event);
        }}
      >
        <label>
          Domanda
          <input
            type="text"
            maxLength={500}
            value={question}
            onInput={(event: Event) => {
              edit((event.currentTarget as HTMLInputElement).value);
            }}
          />
        </label>
        <button type="submit" disabled={query === '' || busy !== undefined}>
          Cerca nel catalogo
        </button>
        <button
          type="button"
          disabled={query === '' || busy !== undefined}
          onClick={() => {
            void ask();
          }}
        >
          {ANSWER_BUTTON}
        </button>
      </form>

      {busy === undefined ? null : (
        <p role="status">{busy === 'search' ? 'Sto cercando…' : 'Il sommelier sta scrivendo…'}</p>
      )}
      {failure === undefined ? null : <p role="alert">{failure}</p>}

      {found === undefined ? null : (
        <section aria-label="Cosa ha trovato il catalogo">
          <h2>Cosa ha trovato il catalogo</h2>
          {found.zeroResultKind === null ? null : <p>{NOTHING_FOUND[found.zeroResultKind]}</p>}
          {found.candidates.length === 0 ? null : (
            <ol>
              {found.candidates.map((candidate) => (
                <li key={candidate.productId}>
                  {candidate.name}
                  {' — '}
                  {candidate.excludedBy === null
                    ? 'proposto al sommelier'
                    : EXCLUDED[candidate.excludedBy]}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {answer === undefined ? null : (
        <section aria-label="La risposta del sommelier">
          <h2>La risposta del sommelier</h2>
          {answer.reply === '' ? null : <p>{answer.reply}</p>}
          {ended === undefined ? null : <p>{ended}</p>}
          {answer.recommendations.length === 0 ? null : (
            <ul>
              {answer.recommendations.map((wine) => (
                <li key={wine.productId}>
                  <strong>{wine.name}</strong>
                  {' — '}
                  {wine.reason}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
};
