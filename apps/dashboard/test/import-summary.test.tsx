import {
  ApiError,
  type ImportPreviewResponse,
  type ProductsImportedResponse,
} from '@catalogorosso/api-client';
import { MAX_IMPORT_BODY_BYTES } from '@catalogorosso/core/import-limits';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseDelimited } from '../src/features/catalog/delimited.js';
import { draftFromRaw, type DraftRow } from '../src/features/catalog/draft-rows.js';
import {
  ImportSummary,
  invalidRowsCsv,
  type ImportSource,
} from '../src/features/catalog/ImportSummary.js';
import type { RawRow } from '../src/features/catalog/template.js';
import { fakeClient, type Route, type Sent } from './support/client.js';

/**
 * The import summary (P1-23).
 *
 * The row's three assertions — counts match a seeded scenario, identical data
 * reports every row *invariati*, invalid rows are downloadable — plus what makes
 * confirming safe: only valid rows are sent, one key per attempt survives a
 * retry, and a stopped import is resumed as a new attempt.
 */

afterEach(cleanup);

const PREVIEW = 'POST /v1/dashboard/products/import/preview';
const IMPORT = 'POST /v1/dashboard/products/import';
const SOURCE: ImportSource = { entryPoint: 'paste' };

const GOOD: RawRow = { name: 'Barolo Bussia', sku: 'BAR-2019', wineType: 'rosso', price: '45,00' };
const BAD: RawRow = { name: 'Etna Rosso', sku: 'ETN-2020', wineType: 'rosso', price: 'quaranta' };

const draftsOf = (...raw: RawRow[]): DraftRow[] =>
  raw.map((row, index) => draftFromRaw(row, index + 1));

const counts = (
  over: Partial<ImportPreviewResponse['counts']> = {},
): ImportPreviewResponse['counts'] => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  duplicateSku: 0,
  archived: 0,
  ...over,
});

const previewOf =
  (over: Partial<ImportPreviewResponse['counts']>): Route =>
  () =>
    Promise.resolve({ outcomes: [], counts: counts(over) });

const imported = (
  stoppedAt: ProductsImportedResponse['stoppedAt'] = null,
  over: Partial<ImportPreviewResponse['counts']> = {},
): ProductsImportedResponse => ({ outcomes: [], counts: counts(over), stoppedAt });

/** A key source that hands out the given keys in order, so a test can say which attempt sent which. */
const keys = (...values: string[]) => {
  const queue = [...values];
  return vi.fn(() => queue.shift() ?? 'no-more-keys');
};

interface Extra {
  readonly newKey?: () => string;
  readonly saveFile?: (text: string, filename: string) => void;
  readonly onImported?: (answer: ProductsImportedResponse) => void;
}

const mount = (
  drafts: readonly DraftRow[],
  routes: Readonly<Record<string, Route>>,
  extra: Extra = {},
) => {
  const { client, request } = fakeClient(routes);
  const view = render(<ImportSummary client={client} drafts={drafts} source={SOURCE} {...extra} />);
  return { client, request, view };
};

const sentTo = (request: ReturnType<typeof fakeClient>['request'], endpoint: string): Sent[] =>
  request.mock.calls.filter(([called]) => called === endpoint).map(([, init]) => init ?? {});

const button = (name: string | RegExp): HTMLButtonElement => screen.getByRole('button', { name });

const withoutBom = (text: string): string => text.replace(/^\uFEFF/, '');

describe('what confirming will change', () => {
  it('shows the server’s counts for the valid rows, with the invalid ones beside them', async () => {
    const { request } = mount(draftsOf(GOOD, { ...GOOD, sku: 'B' }, BAD, { ...GOOD, sku: 'C' }), {
      [PREVIEW]: previewOf({ created: 1, updated: 1, unchanged: 1 }),
    });

    expect(
      await screen.findByText('Nuovi: 1 · Aggiornati: 1 · Invariati: 1 · Non validi: 1'),
    ).toBeTruthy();

    const [sent] = sentTo(request, PREVIEW);
    expect((sent?.body as { rows: unknown[] }).rows).toHaveLength(3);
    // A preview claims nothing, so it carries no key.
    expect(sent?.idempotencyKey).toBeUndefined();
  });

  it('reports every row invariati when the same data is imported again', async () => {
    mount(draftsOf(GOOD, { ...GOOD, sku: 'B' }), { [PREVIEW]: previewOf({ unchanged: 2 }) });

    expect(
      await screen.findByText('Nuovi: 0 · Aggiornati: 0 · Invariati: 2 · Non validi: 0'),
    ).toBeTruthy();
  });

  it('says which rows match archived wines, and that they stay archived', async () => {
    mount(draftsOf(GOOD), { [PREVIEW]: previewOf({ unchanged: 1, archived: 1 }) });

    expect(await screen.findByText(/resterà archiviato/)).toBeTruthy();
  });

  it('warns that rows sharing a SKU will not be imported', async () => {
    mount(draftsOf(GOOD, GOOD), { [PREVIEW]: previewOf({ duplicateSku: 2 }) });

    expect(await screen.findByText(/SKU ripetuti: 2/)).toBeTruthy();
    expect(screen.getByText(/stesso SKU non verranno importate/)).toBeTruthy();
  });

  it('asks the server nothing when no row is valid, and offers nothing to confirm', async () => {
    const { request } = mount(draftsOf(BAD), {});

    expect(
      await screen.findByText('Nuovi: 0 · Aggiornati: 0 · Invariati: 0 · Non validi: 1'),
    ).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    expect(button('Nessuna riga valida da importare').disabled).toBe(true);
  });

  it('offers a retry when the comparison fails, quoting the request id', async () => {
    let calls = 0;
    const { request } = mount(draftsOf(GOOD), {
      [PREVIEW]: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ApiError(500, 'internal', 'boom', 'req-42'))
          : Promise.resolve({ outcomes: [], counts: counts({ created: 1 }) });
      },
    });

    expect(await screen.findByText(/req-42/)).toBeTruthy();
    expect(button('Importa 1 riga').disabled).toBe(true);

    fireEvent.click(button('Riprova'));

    expect(await screen.findByText(/Nuovi: 1/)).toBeTruthy();
    expect(sentTo(request, PREVIEW)).toHaveLength(2);
  });

  it('will not send rows over the request cap, and says how to proceed', async () => {
    const huge = draftsOf({ ...GOOD, tastingNotes: 'x'.repeat(MAX_IMPORT_BODY_BYTES) });
    expect(huge[0]?.payload).toBeDefined();

    const { request } = mount(huge, {});

    expect(await screen.findByText(/Dividile in più importazioni/)).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    expect(button('Importa 1 riga').disabled).toBe(true);
  });
});

describe('the rows to fix', () => {
  it('are listed with what is wrong, and downloadable as a file that imports again', async () => {
    const saveFile = vi.fn<(text: string, filename: string) => void>();
    mount(draftsOf(GOOD, BAD), { [PREVIEW]: previewOf({ created: 1 }) }, { saveFile });

    expect(await screen.findByText(/^Riga 2: /)).toBeTruthy();

    fireEvent.click(button('Scarica le righe da correggere'));

    const [text, filename] = saveFile.mock.calls[0] ?? [];
    expect(filename).toBe('righe-da-correggere.csv');
    expect(text?.startsWith('\uFEFF')).toBe(true);

    const [header, ...rows] = parseDelimited(withoutBom(text ?? ''), ';');
    expect(header?.at(-1)).toBe('errori');
    expect(rows.map((cells) => cells[header?.indexOf('sku') ?? -1])).toEqual(['ETN-2020']);
    expect(rows[0]?.at(-1)).not.toBe('');
  });

  it('keeps a cell holding the delimiter or a quote intact through the file', () => {
    const text = withoutBom(invalidRowsCsv(draftsOf({ ...BAD, name: 'Rosso "Riserva"; Etna' })));
    const [header, row] = parseDelimited(text, ';');

    expect(row?.[header?.indexOf('name') ?? -1]).toBe('Rosso "Riserva"; Etna');
  });

  it('writes availability back in a word the importer reads', () => {
    const text = withoutBom(invalidRowsCsv(draftsOf({ ...BAD, stockStatus: 'esaurito' })));
    const [header, row] = parseDelimited(text, ';');

    expect(row?.[header?.indexOf('stock_status') ?? -1]).toBe('esaurito');
  });

  it('leaves the valid rows out of the file', () => {
    const text = withoutBom(invalidRowsCsv(draftsOf(GOOD)));

    expect(parseDelimited(text, ';')).toHaveLength(1);
  });
});

describe('confirming', () => {
  it('sends only the valid rows, with the source and a key, and says what happened', async () => {
    const onImported = vi.fn();
    const answer = imported(null, { created: 2 });
    const { request } = mount(
      draftsOf(GOOD, BAD, { ...GOOD, sku: 'B' }),
      { [PREVIEW]: previewOf({ created: 2 }), [IMPORT]: () => Promise.resolve(answer) },
      { newKey: keys('key-1'), onImported },
    );

    await screen.findByText(/Nuovi: 2/);
    fireEvent.click(button('Importa solo le 2 righe valide'));

    expect(await screen.findByText(/Importazione completata/)).toBeTruthy();

    const [sent] = sentTo(request, IMPORT);
    expect(sent?.idempotencyKey).toBe('key-1');
    expect(sent?.body).toEqual({
      rows: [draftsOf(GOOD)[0]?.payload, draftsOf({ ...GOOD, sku: 'B' })[0]?.payload],
      source: SOURCE,
    });
    expect(onImported).toHaveBeenCalledWith(answer);
    expect(screen.queryByRole('button', { name: /Importa/ })).toBeNull();
  });

  it('sends the same key again after a failure, so a retry cannot apply the import twice', async () => {
    let calls = 0;
    const newKey = keys('key-1', 'key-2');
    const { request } = mount(
      draftsOf(GOOD),
      {
        [PREVIEW]: previewOf({ created: 1 }),
        [IMPORT]: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new TypeError('Failed to fetch'))
            : Promise.resolve(imported());
        },
      },
      { newKey },
    );

    await screen.findByText(/Nuovi: 1/);
    fireEvent.click(button('Importa 1 riga'));
    expect(await screen.findByText(/Importazione non riuscita/)).toBeTruthy();

    fireEvent.click(button('Importa 1 riga'));
    expect(await screen.findByText(/Importazione completata/)).toBeTruthy();

    expect(sentTo(request, IMPORT).map((sent) => sent.idempotencyKey)).toEqual(['key-1', 'key-1']);
    expect(newKey).toHaveBeenCalledTimes(1);
  });

  it('says an attempt still running is still running, and keeps its key', async () => {
    const { request } = mount(
      draftsOf(GOOD),
      {
        [PREVIEW]: previewOf({ created: 1 }),
        [IMPORT]: () => Promise.reject(new ApiError(409, 'conflict', 'not finished', 'req-7')),
      },
      { newKey: keys('key-1', 'key-2') },
    );

    await screen.findByText(/Nuovi: 1/);
    fireEvent.click(button('Importa 1 riga'));
    expect(await screen.findByText(/ancora in corso/)).toBeTruthy();

    fireEvent.click(button('Importa 1 riga'));
    await waitFor(() => {
      expect(sentTo(request, IMPORT)).toHaveLength(2);
    });

    expect(sentTo(request, IMPORT).map((sent) => sent.idempotencyKey)).toEqual(['key-1', 'key-1']);
  });

  it('resumes an import that stopped part-way as a new attempt, naming the seller’s own line', async () => {
    let calls = 0;
    const { request } = mount(
      draftsOf(BAD, GOOD, { ...GOOD, sku: 'B' }),
      {
        [PREVIEW]: previewOf({ created: 2 }),
        [IMPORT]: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1 ? imported({ batch: 1, fromRow: 2, toRow: 2 }) : imported(),
          );
        },
      },
      { newKey: keys('key-1', 'key-2') },
    );

    await screen.findByText(/Nuovi: 2/);
    fireEvent.click(button('Importa solo le 2 righe valide'));

    // Row 2 of the request is line 3 of the list: line 1 was invalid and never sent.
    expect(await screen.findByText(/si è fermata alla riga 3/)).toBeTruthy();

    fireEvent.click(button('Riprova l’importazione'));

    expect(await screen.findByText(/Importazione completata/)).toBeTruthy();
    expect(sentTo(request, IMPORT).map((sent) => sent.idempotencyKey)).toEqual(['key-1', 'key-2']);
  });

  it('forgets the key when the rows change, since the same key with other rows is refused', async () => {
    const newKey = keys('key-1', 'key-2');
    const { client, request, view } = mount(
      draftsOf(GOOD),
      {
        [PREVIEW]: previewOf({ created: 1 }),
        [IMPORT]: () => Promise.reject(new TypeError('Failed to fetch')),
      },
      { newKey },
    );

    await screen.findByText(/Nuovi: 1/);
    fireEvent.click(button('Importa 1 riga'));
    await screen.findByText(/Importazione non riuscita/);

    view.rerender(
      <ImportSummary
        client={client}
        drafts={draftsOf({ ...GOOD, price: '46,00' })}
        source={SOURCE}
        newKey={newKey}
      />,
    );

    await waitFor(() => {
      expect(sentTo(request, PREVIEW)).toHaveLength(2);
    });
    await screen.findByText(/Nuovi: 1/);

    fireEvent.click(button('Importa 1 riga'));
    await waitFor(() => {
      expect(sentTo(request, IMPORT)).toHaveLength(2);
    });

    expect(sentTo(request, IMPORT).map((sent) => sent.idempotencyKey)).toEqual(['key-1', 'key-2']);
  });
});
