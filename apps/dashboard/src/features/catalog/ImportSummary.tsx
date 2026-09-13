import {
  ApiError,
  type ApiClient,
  type ImportPreviewResponse,
  type ProductRequest,
  type ProductsImportedResponse,
} from '@catalogorosso/api-client';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { writeDelimited } from './delimited.js';
import { importBodyProblem, STOCK_WORD_FOR, type DraftRow } from './draft-rows.js';
import { describeFailure } from './request-failure.js';
import { saveTextFile } from './save-file.js';
import { TEMPLATE_COLUMNS } from './template.js';

/**
 * The confirm gate for an import (P1-23): nuovi, aggiornati, invariati, non validi.
 *
 * **Nothing writes until the seller has seen what will change** (§2.2b). This
 * is the guard against a mis-detected delimiter or the wrong file silently
 * rewriting a catalogue: a paste whose columns slid one to the right shows up
 * here as three hundred "aggiornati" nobody expected, before any of them happen.
 *
 * **The numbers are the server's.** Whether a row is new, changed or unchanged
 * depends on the stored wine, which the dashboard does not have; the preview
 * route runs the import's own planner and writes nothing.
 *
 * **Only the valid rows are sent** — "importa solo le valide", the forgiving
 * default the row recommends — and the invalid ones stay listed, downloadable as
 * a file to fix and import again. Holding a two-thousand-wine import hostage to
 * three typos is the stricter reading, and not a kinder one.
 */

export type ImportEntryPoint = 'form' | 'paste' | 'file';

export interface ImportSource {
  readonly entryPoint: ImportEntryPoint;
  readonly filename?: string;
}

const NO_COUNTS: ImportPreviewResponse['counts'] = {
  created: 0,
  updated: 0,
  unchanged: 0,
  duplicateSku: 0,
  archived: 0,
};

/**
 * The rows still to fix, as a file the seller can open, correct and import again.
 *
 * Template headers, `;` and a byte-order mark: what Excel opens in Italy without
 * a wizard, and what the file importer reads back (P1-16, P1-17). The last
 * column says what is wrong; a column the importer does not know is ignored with
 * a notice (P1-19), so the corrected file imports as it is.
 */
export const invalidRowsCsv = (drafts: readonly DraftRow[]): string => {
  const header = [...TEMPLATE_COLUMNS.map((column) => column.header), 'errori'];
  const body = drafts
    .filter((row) => row.payload === undefined)
    .map((row) => [
      ...TEMPLATE_COLUMNS.map(({ field }) =>
        field === 'stockStatus' ? STOCK_WORD_FOR[row.values.stockStatus] : row.values[field],
      ),
      Object.values(row.errors).join(' · '),
    ]);

  return '\uFEFF' + writeDelimited([header, ...body], ';');
};

const countsText = (counts: ImportPreviewResponse['counts'], invalid: number): string =>
  [
    `Nuovi: ${String(counts.created)}`,
    `Aggiornati: ${String(counts.updated)}`,
    `Invariati: ${String(counts.unchanged)}`,
    `Non validi: ${String(invalid)}`,
    ...(counts.duplicateSku > 0 ? [`SKU ripetuti: ${String(counts.duplicateSku)}`] : []),
  ].join(' · ');

const archivedText = (archived: number): string =>
  archived === 1
    ? '1 riga corrisponde a un vino archiviato, che resterà archiviato.'
    : `${String(archived)} righe corrispondono a vini archiviati, che resteranno archiviati.`;

const confirmLabel = (valid: number, invalid: number): string => {
  if (valid === 0) return 'Nessuna riga valida da importare';
  if (invalid === 0) return valid === 1 ? 'Importa 1 riga' : `Importa ${String(valid)} righe`;
  return valid === 1
    ? 'Importa solo la riga valida'
    : `Importa solo le ${String(valid)} righe valide`;
};

/**
 * What the import answered, in the seller's words.
 *
 * A stop is reported by the rows the server was sent, and the seller counts the
 * lines of the list they saw — which differ as soon as an invalid line was left
 * out. So the numbers are translated back before they are shown.
 */
const resultText = (answer: ProductsImportedResponse, sent: readonly DraftRow[]): string => {
  const { created, updated, unchanged } = answer.counts;

  if (answer.stoppedAt === null) {
    return `Importazione completata. Nuovi: ${String(created)} · Aggiornati: ${String(updated)} · Invariati: ${String(unchanged)}.`;
  }

  const line = (requestRow: number): number => sent[requestRow - 1]?.position ?? requestRow;
  const from = line(answer.stoppedAt.fromRow);
  const to = line(answer.stoppedAt.toRow);
  const where =
    from === to ? `alla riga ${String(from)}` : `tra la riga ${String(from)} e la ${String(to)}`;

  return (
    `L’importazione si è fermata ${where}: le righe precedenti sono state importate. ` +
    'Riprova per importare le restanti; quelle già importate non verranno ripetute.'
  );
};

export interface ImportSummaryProps {
  readonly client: ApiClient;
  readonly drafts: readonly DraftRow[];
  readonly source: ImportSource;
  readonly onImported?: ((answer: ProductsImportedResponse) => void) | undefined;
  /** Where each attempt's key comes from. Injected so a test can name the key it expects. */
  readonly newKey?: (() => string) | undefined;
  /** How a file reaches the seller. Injected so a test can read it without a browser download. */
  readonly saveFile?: ((text: string, filename: string) => void) | undefined;
}

type Preview =
  | { readonly status: 'loading' }
  | { readonly status: 'skipped' }
  | { readonly status: 'ready'; readonly counts: ImportPreviewResponse['counts'] }
  | { readonly status: 'failed'; readonly message: string };

type Attempt =
  | { readonly status: 'idle' }
  | { readonly status: 'sending' }
  | { readonly status: 'done'; readonly answer: ProductsImportedResponse }
  | { readonly status: 'failed'; readonly message: string };

export const ImportSummary = ({
  client,
  drafts,
  source,
  onImported,
  newKey = () => crypto.randomUUID(),
  saveFile = saveTextFile,
}: ImportSummaryProps): JSX.Element => {
  const valid = useMemo(() => drafts.filter((row) => row.payload !== undefined), [drafts]);
  const invalid = useMemo(() => drafts.filter((row) => row.payload === undefined), [drafts]);
  const payloads = useMemo(
    () =>
      valid.flatMap((row): ProductRequest[] => (row.payload === undefined ? [] : [row.payload])),
    [valid],
  );
  const tooLarge = useMemo(() => importBodyProblem(payloads), [payloads]);

  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  const [attempt, setAttempt] = useState<Attempt>({ status: 'idle' });
  const [previewTry, setPreviewTry] = useState(0);

  /*
   * **The key belongs to these rows.** Made at the first confirmation and sent
   * again with every retry of it, so a double-click or a dropped connection
   * cannot apply the import twice (P1-26). Forgotten when the rows change — the
   * same key with other rows is refused — and when an attempt finishes, because
   * resuming a stopped import is a new attempt.
   */
  const key = useRef<string | undefined>(undefined);

  /** Which rows an answer belongs to. An answer for rows edited since is dropped. */
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    key.current = undefined;
    setAttempt({ status: 'idle' });

    if (payloads.length === 0 || tooLarge !== null) {
      setPreview({ status: 'skipped' });
      return;
    }

    setPreview({ status: 'loading' });

    void client
      .request('POST /v1/dashboard/products/import/preview', { body: { rows: payloads } })
      .then(
        (answer) => {
          if (mine === generation.current) setPreview({ status: 'ready', counts: answer.counts });
        },
        (error: unknown) => {
          if (mine !== generation.current) return;
          setPreview({
            status: 'failed',
            message: describeFailure(
              'Il confronto con il catalogo non è riuscito. Riprova tra poco.',
              error,
            ),
          });
        },
      );
  }, [client, payloads, tooLarge, previewTry]);

  const confirm = async (): Promise<void> => {
    const mine = generation.current;
    const attemptKey = key.current ?? newKey();
    key.current = attemptKey;
    setAttempt({ status: 'sending' });

    try {
      const answer = await client.request('POST /v1/dashboard/products/import', {
        body: { rows: payloads, source },
        idempotencyKey: attemptKey,
      });
      if (mine !== generation.current) return;

      key.current = undefined;
      setAttempt({ status: 'done', answer });
      onImported?.(answer);
    } catch (error) {
      if (mine !== generation.current) return;

      /*
       * **The key is kept.** A failure can come after the import ran, on a
       * connection that dropped on the way back; the same key sent again answers
       * with that import's result, or says it is still running, and never
       * applies it twice (P1-26). A 409 here is the second case: the key is
       * forgotten whenever the rows change, so it cannot be the other one.
       */
      setAttempt({
        status: 'failed',
        message:
          error instanceof ApiError && error.status === 409
            ? 'L’importazione è ancora in corso. Riprova tra poco per vederne il risultato.'
            : describeFailure(
                'Importazione non riuscita. Riprova: le righe già importate non verranno importate due volte.',
                error,
              ),
      });
    }
  };

  const finished = attempt.status === 'done' && attempt.answer.stoppedAt === null;
  const stopped = attempt.status === 'done' && attempt.answer.stoppedAt !== null;
  const canConfirm = preview.status === 'ready' && attempt.status !== 'sending' && !finished;

  return (
    <section class="cr-import-summary" aria-labelledby="import-summary-title">
      <h2 id="import-summary-title">Riepilogo dell’importazione</h2>

      {preview.status === 'loading' && (
        <p class="cr-import-summary__counts" aria-busy="true">
          Confronto con il catalogo…
        </p>
      )}

      {(preview.status === 'ready' || preview.status === 'skipped') && (
        <p class="cr-import-summary__counts" role="status">
          {countsText(preview.status === 'ready' ? preview.counts : NO_COUNTS, invalid.length)}
        </p>
      )}

      {preview.status === 'ready' && preview.counts.duplicateSku > 0 && (
        <p class="cr-import-summary__note">
          Le righe con lo stesso SKU non verranno importate: lasciane una sola per vino.
        </p>
      )}

      {preview.status === 'ready' && preview.counts.archived > 0 && (
        <p class="cr-import-summary__note">{archivedText(preview.counts.archived)}</p>
      )}

      {preview.status === 'failed' && (
        <div class="cr-banner cr-banner--danger" role="alert">
          <p>{preview.message}</p>
          <button
            type="button"
            onClick={() => {
              setPreviewTry((count) => count + 1);
            }}
          >
            Riprova
          </button>
        </div>
      )}

      {tooLarge !== null && (
        <p class="cr-banner cr-banner--danger" role="alert">
          {tooLarge}
        </p>
      )}

      {invalid.length > 0 && (
        <details class="cr-import-summary__invalid">
          <summary>{`Righe da correggere (${String(invalid.length)})`}</summary>
          <ul>
            {invalid.map((row) => (
              <li key={row.id}>
                {`Riga ${String(row.position)}: ${Object.values(row.errors).join(' · ')}`}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              saveFile(invalidRowsCsv(drafts), 'righe-da-correggere.csv');
            }}
          >
            Scarica le righe da correggere
          </button>
        </details>
      )}

      {attempt.status === 'done' && (
        <p class="cr-import-summary__result" role="status">
          {resultText(attempt.answer, valid)}
        </p>
      )}

      {attempt.status === 'failed' && (
        <p class="cr-banner cr-banner--danger" role="alert">
          {attempt.message}
        </p>
      )}

      {!finished && (
        <button
          type="button"
          class="cr-import-summary__confirm"
          disabled={!canConfirm}
          onClick={() => {
            void confirm();
          }}
        >
          {attempt.status === 'sending'
            ? 'Importazione in corso…'
            : stopped
              ? 'Riprova l’importazione'
              : confirmLabel(valid.length, invalid.length)}
        </button>
      )}
    </section>
  );
};
