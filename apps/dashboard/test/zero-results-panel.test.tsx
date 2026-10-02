import type { ZeroResultsResponse } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseDelimited } from '../src/features/catalog/delimited.js';
import {
  HEADERS,
  inert,
  rowsOf,
  themeSentence,
  ZeroResultsPanel,
  zeroResultsCsv,
} from '../src/features/analytics/ZeroResultsPanel.js';
import { fakeClient } from './support/client.js';

/**
 * Domande senza risposta (P6-04, §2.4): the patterns, every question with both
 * kinds, and an export that is the view.
 */

afterEach(cleanup);

const RANGE = { from: '2026-09-02', to: '2026-10-01' };

const answer = (overrides: Partial<ZeroResultsResponse> = {}): ZeroResultsResponse => ({
  from: '2026-09-02',
  to: '2026-10-01',
  conversations: 31,
  themes: [
    { id: 'sweet', label: 'vini dolci', conversations: 14 },
    { id: 'organic', label: 'vini biologici o naturali', conversations: 1 },
  ],
  questions: [
    {
      question: 'avete un passito?',
      conversations: 6,
      noMatch: 5,
      notRecommended: 1,
      lastAskedAt: '2026-09-30T19:12:00.000Z',
    },
    {
      question: '=hyperlink("https://evil.example","clic")',
      conversations: 1,
      noMatch: 1,
      notRecommended: 0,
      lastAskedAt: '2026-09-12T09:00:00.000Z',
    },
  ],
  ...overrides,
});

const answering = (read: ZeroResultsResponse | Error) =>
  fakeClient({
    'GET /v1/dashboard/analytics/zero-results': () =>
      read instanceof Error ? Promise.reject(read) : Promise.resolve(read),
  });

const tableRows = async (): Promise<(string | undefined)[][]> => {
  const region = await screen.findByRole('region', { name: 'Domande senza risposta' });
  const table = within(region).getByRole('table');

  return [...table.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim()),
  );
};

describe('the patterns', () => {
  it('say how many visitors asked for what, in the singular for one', async () => {
    const { client } = answering(answer());

    render(<ZeroResultsPanel client={client} range={RANGE} />);

    const themes = await screen.findByRole('list', { name: 'Cosa cercavano' });

    expect([...themes.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '14 visitatori hanno chiesto vini dolci',
      '1 visitatore ha chiesto vini biologici o naturali',
    ]);
  });

  it('say how many conversations went unanswered', async () => {
    const { client } = answering(answer());

    render(<ZeroResultsPanel client={client} range={RANGE} />);

    expect(
      await screen.findByText(
        '31 conversazioni hanno chiesto qualcosa che il sommelier non ha potuto consigliare.',
      ),
    ).toBeTruthy();
  });

  it('group in thousands as an Italian reads them', () => {
    expect(themeSentence({ id: 'sweet', label: 'vini dolci', conversations: 1_400 })).toBe(
      '1.400 visitatori hanno chiesto vini dolci',
    );
  });
});

describe('the list', () => {
  it('shows each question with both kinds and when it was last asked', async () => {
    const { client } = answering(answer());

    render(<ZeroResultsPanel client={client} range={RANGE} />);

    expect(await tableRows()).toEqual([
      ['avete un passito?', '6', '5', '1', '30 settembre 2026'],
      ['=hyperlink("https://evil.example","clic")', '1', '1', '0', '12 settembre 2026'],
    ]);
  });

  it('says so when every question had a wine, rather than an empty table', async () => {
    const { client } = answering(answer({ conversations: 0, themes: [], questions: [] }));

    render(<ZeroResultsPanel client={client} range={RANGE} />);

    expect(
      await screen.findByText(
        'Ogni domanda di questo periodo ha avuto almeno un vino consigliato.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Esporta CSV' })).toBeNull();
  });

  it('says it could not read them, rather than showing nothing', async () => {
    const { client } = answering(new Error('down'));

    render(<ZeroResultsPanel client={client} range={RANGE} />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Non è stato possibile leggere le domande senza risposta.',
    );
  });

  it('asks for exactly the range it was given', async () => {
    const { client, request } = answering(answer());

    render(<ZeroResultsPanel client={client} range={{ from: '2026-08-01', to: '2026-08-31' }} />);

    await screen.findByRole('table');
    expect(request).toHaveBeenCalledWith('GET /v1/dashboard/analytics/zero-results', {
      query: { from: '2026-08-01', to: '2026-08-31' },
    });
  });
});

describe('the export', () => {
  it('is the view: the same headers and the same cells, row for row', async () => {
    const { client } = answering(answer());
    const save = vi.fn<(text: string, filename: string) => void>();

    render(<ZeroResultsPanel client={client} range={RANGE} save={save} />);

    const shown = await tableRows();

    fireEvent.click(screen.getByRole('button', { name: 'Esporta CSV' }));

    const [text, filename] = save.mock.calls[0] ?? [];
    const [header, ...rows] = parseDelimited((text ?? '').replace(/^\uFEFF/u, ''), ',');

    expect(filename).toBe('domande-senza-risposta-2026-09-02-2026-10-01.csv');
    expect(header).toEqual([...HEADERS]);
    /* What a spreadsheet would show: the apostrophe that keeps a formula inert is not displayed. */
    expect(rows.map((row) => row.map((cell) => cell.replace(/^'/u, '')))).toEqual(shown);
  });

  it('never hands a spreadsheet a formula a visitor typed', () => {
    const [, , attack] = parseDelimited(zeroResultsCsv(rowsOf(answer())).slice(1), ',');

    expect(attack?.[0]).toBe('\'=hyperlink("https://evil.example","clic")');
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])('makes %j inert', (cell) => {
    expect(inert(cell)).toBe(`'${cell}`);
  });

  it('leaves an ordinary question alone', () => {
    expect(inert('avete un passito?')).toBe('avete un passito?');
    expect(inert('vino rosso - leggero')).toBe('vino rosso - leggero');
  });

  it('starts with a byte-order mark, so Excel reads the accents', () => {
    expect(zeroResultsCsv([]).startsWith('\uFEFF')).toBe(true);
  });
});
