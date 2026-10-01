import type { FunnelResponse } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Layout } from '../src/app.js';

import { AnalyticsScreen, FunnelPanel } from '../src/features/analytics/AnalyticsScreen.js';
import { rangeOf, STAGE_LABELS } from '../src/features/analytics/analytics-copy.js';
import { fakeClient } from './support/client.js';

/**
 * Analisi (P6-02, §2.4): the funnel as a seller reads it. The numbers are the
 * API's; what is held here is that they are shown as they came, labelled
 * honestly, and asked for over the range the seller picked.
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

const answering = (answer: FunnelResponse | Error) =>
  fakeClient({
    'GET /v1/dashboard/analytics/funnel': () =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
  });

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

describe('the screen', () => {
  it('starts on the last thirty days, today included, in UTC', async () => {
    const { client, request } = answering(funnel());

    render(<AnalyticsScreen client={client} now={() => NOW} />);

    await screen.findByRole('table');
    expect(request).toHaveBeenLastCalledWith('GET /v1/dashboard/analytics/funnel', {
      query: { from: '2026-09-02', to: '2026-10-01' },
    });
  });

  it('asks again for the range a seller picks', async () => {
    const { client, request } = answering(funnel());

    render(<AnalyticsScreen client={client} now={() => NOW} />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByRole('combobox', { name: /Periodo/u }), {
      target: { value: '7' },
    });

    await waitFor(() => {
      expect(request).toHaveBeenLastCalledWith('GET /v1/dashboard/analytics/funnel', {
        query: { from: '2026-09-25', to: '2026-10-01' },
      });
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
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(clientFor).toHaveBeenCalledWith(TENANT);
    expect(screen.getByRole('link', { name: 'Analisi' }).getAttribute('href')).toBe('/analisi');
  });
});
