import type { FunnelResponse, TopResponse } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Layout } from '../src/app.js';

import {
  AnalyticsScreen,
  FunnelPanel,
  TopPanels,
} from '../src/features/analytics/AnalyticsScreen.js';
import { rangeOf, STAGE_LABELS } from '../src/features/analytics/analytics-copy.js';
import { fakeClient } from './support/client.js';

/**
 * Analisi (P6-02, P6-03, §2.4): the funnel, the questions and the wines as a
 * seller reads them. The numbers are the API's; what is held here is that they
 * are shown as they came, labelled honestly, and asked for over the range the
 * seller picked.
 */

afterEach(cleanup);

const NOW = new Date('2026-10-01T15:30:00.000Z');

const funnel = (overrides: Partial<FunnelResponse> = {}): FunnelResponse => ({
  from: '2026-09-02',
  to: '2026-10-01',
  stages: [
    { stage: 'WIDGET_OPEN', sessions: 1_200, rate: null },
    { stage: 'MESSAGE_SENT', sessions: 480, rate: 0.4 },
    { stage: 'RECOMMENDATION_SHOWN', sessions: 360, rate: 0.75 },
    { stage: 'ADD_TO_CART', sessions: 45, rate: 0.125 },
  ],
  ...overrides,
});

const BAROLO = '9b2f4c1e-6a3d-4e8b-9f10-2c7d5e8a1b34';
const CHIANTI = '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const GONE = '0c6f1d2a-5b4e-4c3d-8a9b-7e6f5d4c3b2a';

const top = (overrides: Partial<TopResponse> = {}): TopResponse => ({
  from: '2026-09-02',
  to: '2026-10-01',
  queries: [
    { query: 'prosecco?', conversations: 21, lastAskedAt: '2026-09-30T19:12:00.000Z' },
    {
      query: 'un rosso per la bistecca',
      conversations: 14,
      lastAskedAt: '2026-09-28T10:00:00.000Z',
    },
  ],
  products: [
    {
      productId: BAROLO,
      name: 'Barolo',
      archived: false,
      recommended: 1_040,
      addedToCart: 156,
      rate: 0.15,
    },
    {
      productId: CHIANTI,
      name: 'Chianti',
      archived: true,
      recommended: 8,
      addedToCart: 1,
      rate: 0.125,
    },
    { productId: GONE, name: null, archived: false, recommended: 4, addedToCart: 0, rate: 0 },
  ],
  ...overrides,
});

const answering = (answer: FunnelResponse | Error, topAnswer: TopResponse | Error = top()) =>
  fakeClient({
    'GET /v1/dashboard/analytics/funnel': () =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
    'GET /v1/dashboard/analytics/top': () =>
      topAnswer instanceof Error ? Promise.reject(topAnswer) : Promise.resolve(topAnswer),
    'GET /v1/dashboard/analytics/zero-results': () =>
      Promise.resolve({
        from: '2026-09-02',
        to: '2026-10-01',
        conversations: 0,
        themes: [],
        questions: [],
      }),
    'GET /v1/dashboard/analytics/origins': () =>
      Promise.resolve({ from: '2026-09-02', to: '2026-10-01', origins: [] }),
  });

const RANGE = { from: '2026-09-02', to: '2026-10-01' };

/** The rows of a table inside the region of that name, cell by cell. */
const rowsIn = async (region: string): Promise<(string | undefined)[][]> => {
  const table = within(await screen.findByRole('region', { name: region })).getByRole('table');

  return [...table.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim()),
  );
};

describe('the funnel', () => {
  it('shows each stage, its visits and the share of the step before', async () => {
    const { client } = answering(funnel());

    render(<FunnelPanel client={client} range={{ from: '2026-09-02', to: '2026-10-01' }} />);

    const table = await screen.findByRole('table');
    const rows = [...table.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim()),
    );

    expect(rows).toEqual([
      ['Aperture del sommelier', '1.200', '—'],
      ['Domande', '480', '40%'],
      ['Consigli mostrati', '360', '75%'],
      ['Aggiunte al carrello', '45', '12,5%'],
    ]);
  });

  it('says which days it covers, as the API counted them', async () => {
    const { client } = answering(funnel());

    render(<FunnelPanel client={client} range={{ from: '2026-09-02', to: '2026-10-01' }} />);

    expect((await screen.findByRole('table')).querySelector('caption')?.textContent).toBe(
      'Dal 2 settembre 2026 al 1 ottobre 2026',
    );
  });

  it('calls the last stage an add to cart, never a sale (§2.4)', async () => {
    const { client } = answering(funnel());

    render(<FunnelPanel client={client} range={{ from: '2026-09-02', to: '2026-10-01' }} />);

    const panel = await screen.findByRole('region', { name: 'Percorso dei visitatori' });

    await screen.findByRole('table');
    expect(STAGE_LABELS.ADD_TO_CART).toBe('Aggiunte al carrello');
    expect(panel.textContent).not.toMatch(/vendite realizzate|fatturato|ricavi/iu);
    expect(panel.querySelectorAll('tbody th')[3]?.textContent).not.toMatch(/vendit/iu);
  });

  it('says so when nobody opened the sommelier, rather than a table of zeros', async () => {
    const { client } = answering(
      funnel({
        stages: funnel().stages.map((step) => ({ ...step, sessions: 0, rate: null })),
      }),
    );

    render(<FunnelPanel client={client} range={{ from: '2026-09-02', to: '2026-10-01' }} />);

    expect(
      await screen.findByText('Nessuna visita ha aperto il sommelier in questo periodo.'),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says it could not read the funnel, rather than showing nothing', async () => {
    const { client } = answering(new Error('down'));

    render(<FunnelPanel client={client} range={{ from: '2026-09-02', to: '2026-10-01' }} />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Non è stato possibile leggere il percorso.',
    );
  });

  it('asks for exactly the range it was given', async () => {
    const { client, request } = answering(funnel());

    render(<FunnelPanel client={client} range={{ from: '2026-08-01', to: '2026-08-31' }} />);

    await screen.findByRole('table');
    expect(request).toHaveBeenCalledWith('GET /v1/dashboard/analytics/funnel', {
      query: { from: '2026-08-01', to: '2026-08-31' },
    });
  });
});

describe('the questions and the wines (P6-03)', () => {
  it('lists the questions with their conversations and when last asked', async () => {
    const { client } = answering(funnel());

    render(<TopPanels client={client} range={RANGE} />);

    expect(await rowsIn('Domande più frequenti')).toEqual([
      ['prosecco?', '21', '30 settembre 2026'],
      ['un rosso per la bistecca', '14', '28 settembre 2026'],
    ]);
  });

  it('says why a question asked once is not there', async () => {
    const { client } = answering(funnel());

    render(<TopPanels client={client} range={RANGE} />);

    expect(
      (await screen.findByRole('region', { name: 'Domande più frequenti' })).textContent,
    ).toContain('almeno 3 conversazioni');
  });

  it('lists the wines with what became of each, and its conversion', async () => {
    const { client } = answering(funnel());

    render(<TopPanels client={client} range={RANGE} />);

    expect(await rowsIn('Vini più consigliati')).toEqual([
      ['Barolo', '1.040', '156', '15%'],
      ['Chianti (archiviato)', '8', '1', '12,5%'],
      ['Vino non più in catalogo', '4', '0', '0%'],
    ]);
  });

  it('says so when there is nothing to list, rather than an empty table', async () => {
    const { client } = answering(funnel(), top({ queries: [], products: [] }));

    render(<TopPanels client={client} range={RANGE} />);

    expect(
      await screen.findByText(
        'Nessuna domanda è stata fatta in almeno 3 conversazioni in questo periodo.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Il sommelier non ha consigliato nessun vino in questo periodo.'),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says it could not read them, rather than showing nothing', async () => {
    const { client } = answering(funnel(), new Error('down'));

    render(<TopPanels client={client} range={RANGE} />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Non è stato possibile leggere domande e vini consigliati.',
    );
  });

  it('asks for exactly the range it was given', async () => {
    const { client, request } = answering(funnel());

    render(<TopPanels client={client} range={{ from: '2026-08-01', to: '2026-08-31' }} />);

    await screen.findByRole('region', { name: 'Vini più consigliati' });
    expect(request).toHaveBeenCalledWith('GET /v1/dashboard/analytics/top', {
      query: { from: '2026-08-01', to: '2026-08-31' },
    });
  });
});

describe('the screen', () => {
  it('starts every panel on the last thirty days, today included, in UTC', async () => {
    const { client, request } = answering(funnel());

    render(<AnalyticsScreen client={client} now={() => NOW} />);

    await screen.findByRole('region', { name: 'Vini più consigliati' });
    for (const endpoint of [
      'GET /v1/dashboard/analytics/funnel',
      'GET /v1/dashboard/analytics/top',
      'GET /v1/dashboard/analytics/zero-results',
      'GET /v1/dashboard/analytics/origins',
    ]) {
      expect(request).toHaveBeenCalledWith(endpoint, {
        query: { from: '2026-09-02', to: '2026-10-01' },
      });
    }
  });

  it('asks every panel again for the range a seller picks', async () => {
    const { client, request } = answering(funnel());

    render(<AnalyticsScreen client={client} now={() => NOW} />);
    await screen.findByRole('region', { name: 'Vini più consigliati' });

    fireEvent.change(screen.getByRole('combobox', { name: /Periodo/u }), {
      target: { value: '7' },
    });

    await waitFor(() => {
      for (const endpoint of [
        'GET /v1/dashboard/analytics/funnel',
        'GET /v1/dashboard/analytics/top',
        'GET /v1/dashboard/analytics/zero-results',
        'GET /v1/dashboard/analytics/origins',
      ]) {
        expect(request).toHaveBeenCalledWith(endpoint, {
          query: { from: '2026-09-25', to: '2026-10-01' },
        });
      }
    });
  });
});

describe('a range choice', () => {
  it('is whole UTC days ending today', () => {
    expect(rangeOf(7, NOW)).toEqual({ from: '2026-09-25', to: '2026-10-01' });
    expect(rangeOf(90, NOW)).toEqual({ from: '2026-07-04', to: '2026-10-01' });
    /* Half past midnight in Rome is still the day before in UTC. */
    expect(rangeOf(30, new Date('2026-09-30T22:30:00.000Z')).to).toBe('2026-09-30');
  });
});

describe('the /analisi route', () => {
  it('mounts the screen for an editor too, with a client for the active winery', async () => {
    /* `analytics:read` is every role's: the editor is often the one watching. */
    const TENANT = '11111111-1111-4111-8111-111111111111';

    globalThis.history.pushState({}, '', '/analisi');
    const { client } = answering(funnel());
    const clientFor = vi.fn(() => client);

    render(
      <Layout
        session={{
          status: 'signed-in',
          userId: 'user_matteo',
          twoFactorEnabled: false,
          memberships: [{ tenantId: TENANT, role: 'EDITOR' }],
          active: { tenantId: TENANT, role: 'EDITOR' },
        }}
        clientFor={clientFor}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Analisi' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Percorso dei visitatori' })).toBeTruthy();
    expect(clientFor).toHaveBeenCalledWith(TENANT);
    expect(screen.getByRole('link', { name: 'Analisi' }).getAttribute('href')).toBe('/analisi');
  });

  it.each([
    ['OWNER', 1],
    ['EDITOR', 0],
  ] as const)(
    'offers %s the one-click add as the capability table says (P6-05)',
    async (role, buttons) => {
      const TENANT = '11111111-1111-4111-8111-111111111111';

      globalThis.history.pushState({}, '', '/analisi');
      const { client } = fakeClient({
        'GET /v1/dashboard/analytics/funnel': () => Promise.resolve(funnel()),
        'GET /v1/dashboard/analytics/top': () => Promise.resolve(top()),
        'GET /v1/dashboard/analytics/zero-results': () =>
          Promise.resolve({
            from: '2026-09-02',
            to: '2026-10-01',
            conversations: 0,
            themes: [],
            questions: [],
          }),
        'GET /v1/dashboard/analytics/origins': () =>
          Promise.resolve({
            from: '2026-09-02',
            to: '2026-10-01',
            origins: [
              {
                origin: 'https://shop.cantina.example',
                attempts: 4,
                sources: 2,
                lastSeenAt: '2026-09-30T19:12:00.000Z',
                domain: null,
              },
            ],
          }),
      });

      render(
        <Layout
          session={{
            status: 'signed-in',
            userId: 'user_matteo',
            twoFactorEnabled: true,
            memberships: [{ tenantId: TENANT, role }],
            active: { tenantId: TENANT, role },
          }}
          clientFor={() => client}
        />,
      );

      const panel = await screen.findByRole('region', { name: 'Siti non autorizzati' });

      await within(panel).findByRole('table');
      expect(within(panel).queryAllByRole('button', { name: 'È mio, aggiungilo' })).toHaveLength(
        buttons,
      );
    },
  );
});
