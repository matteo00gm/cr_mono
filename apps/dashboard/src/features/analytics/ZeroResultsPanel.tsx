import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { ApiClient, ZeroResultsResponse } from '@catalogorosso/api-client';

import { writeDelimited } from '../catalog/delimited.js';
import { saveTextFile } from '../catalog/save-file.js';
import { count, day } from './analytics-copy.js';

/**
 * Domande senza risposta (P6-04, §2.4): the panel that tells a seller what to
 * stock.
 *
 * **The patterns first**, because *"14 visitatori hanno chiesto vini dolci"*
 * is what a seller acts on; then every question, with the two kinds of "no
 * wine" told apart, because they have different fixes.
 *
 * **One list of rows, for the table and the file.** The export is written
 * from exactly the cells the table shows, so it cannot drift from the view.
 * Every cell is made inert for a spreadsheet: these are words a visitor typed,
 * and a question beginning `=` is a formula in Excel — on the seller's
 * machine, with the seller's permissions.
 */

export const HEADERS = [
  'Domanda',
  'Conversazioni',
  'Nessun vino corrispondente',
  'Vini non adatti',
  'Ultima volta',
] as const;

/** The table's cells, in the table's order: what the view shows and the export writes. */
export const rowsOf = (answer: ZeroResultsResponse): string[][] =>
  answer.questions.map((question) => [
    question.question,
    count(question.conversations),
    count(question.noMatch),
    count(question.notRecommended),
    day(question.lastAskedAt.slice(0, 10)),
  ]);

/**
 * A cell a spreadsheet will read as text. Excel, LibreOffice and Sheets run a
 * cell beginning `=`, `+`, `-` or `@` as a formula, and a tab or a carriage
 * return can hide one; an apostrophe in front is the standard way to say
 * "this is text", and it is not shown.
 */
export const inert = (cell: string): string => (/^[=+\-@\t\r]/u.test(cell) ? `'${cell}` : cell);

/** The file: a byte-order mark so Excel reads the accents, the headers, then the rows as shown. */
export const zeroResultsCsv = (rows: readonly (readonly string[])[]): string =>
  '\uFEFF' +
  writeDelimited(
    [[...HEADERS], ...rows].map((row) => row.map(inert)),
    ',',
  );

/** `14 visitatori hanno chiesto vini dolci`, or one visitor, in the singular. */
export const themeSentence = (theme: ZeroResultsResponse['themes'][number]): string =>
  theme.conversations === 1
    ? `1 visitatore ha chiesto ${theme.label}`
    : `${count(theme.conversations)} visitatori hanno chiesto ${theme.label}`;

export const ZeroResultsPanel = ({
  client,
  range,
  save = saveTextFile,
}: {
  readonly client: ApiClient;
  readonly range: { readonly from: string; readonly to: string };
  /** Where the file goes. Injected, because a test can read a string and not a download. */
  readonly save?: ((text: string, filename: string) => void) | undefined;
}): JSX.Element => {
  const [answer, setAnswer] = useState<ZeroResultsResponse | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;

    setFailed(false);
    client
      .request('GET /v1/dashboard/analytics/zero-results', {
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

  if (failed) {
    return (
      <section class="cr-zero" aria-label="Domande senza risposta">
        <h2>Domande senza risposta</h2>
        <p role="alert">
          Non è stato possibile leggere le domande senza risposta. Riprova fra un momento.
        </p>
      </section>
    );
  }

  if (answer === undefined) {
    return <section class="cr-zero" aria-label="Domande senza risposta" aria-busy="true" />;
  }

  const rows = rowsOf(answer);

  return (
    <section class="cr-zero" aria-label="Domande senza risposta">
      <h2>Domande senza risposta</h2>
      {answer.conversations === 0 ? (
        <p>Ogni domanda di questo periodo ha avuto almeno un vino consigliato.</p>
      ) : (
        <>
          <p>
            {answer.conversations === 1
              ? '1 conversazione ha chiesto qualcosa che il sommelier non ha potuto consigliare.'
              : `${count(answer.conversations)} conversazioni hanno chiesto qualcosa che il sommelier non ha potuto consigliare.`}
          </p>
          {answer.themes.length === 0 ? null : (
            <ul class="cr-zero__themes" aria-label="Cosa cercavano">
              {answer.themes.map((theme) => (
                <li key={theme.id}>{themeSentence(theme)}</li>
              ))}
            </ul>
          )}
          <table>
            <thead>
              <tr>
                {HEADERS.map((header) => (
                  <th key={header} scope="col">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row[0]}>
                  <th scope="row">{row[0]}</th>
                  {row.slice(1).map((cell, index) => (
                    <td key={HEADERS[index + 1]}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p class="cr-zero__note">
            «Nessun vino corrispondente»: nessun vino del catalogo corrisponde alle parole della
            domanda. «Vini non adatti»: alcuni vini corrispondevano, ma il sommelier non li ha
            consigliati.
          </p>
          <button
            type="button"
            onClick={() => {
              save(zeroResultsCsv(rows), `domande-senza-risposta-${answer.from}-${answer.to}.csv`);
            }}
          >
            Esporta CSV
          </button>
        </>
      )}
    </section>
  );
};
