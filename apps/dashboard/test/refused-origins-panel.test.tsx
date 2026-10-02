import { ApiError, type RefusedOriginsResponse } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { RefusedOriginsPanel } from '../src/features/analytics/RefusedOriginsPanel.js';
import { fakeClient, type Route } from './support/client.js';

/**
 * Siti non autorizzati (P6-05, §3.2): the refused sites, led by the fix, and
 * the one-click add that goes through the ordinary route — and comes back
 * `PENDING`, never trusted.
 */

afterEach(cleanup);

const RANGE = { from: '2026-09-02', to: '2026-10-01' };
const SHOP = 'https://shop.cantina.example';

const answer = (overrides: Partial<RefusedOriginsResponse> = {}): RefusedOriginsResponse => ({
  from: '2026-09-02',
  to: '2026-10-01',
  origins: [
    {
      origin: SHOP,
      attempts: 212,
      sources: 37,
      lastSeenAt: '2026-09-30T19:12:00.000Z',
      domain: null,
    },
    {
      origin: 'https://www.cantina.example',
      attempts: 3,
      sources: 1,
      lastSeenAt: '2026-09-29T08:00:00.000Z',
      domain: 'PENDING',
    },
    {
      origin: 'null',
      attempts: 2,
      sources: 2,
      lastSeenAt: '2026-09-28T08:00:00.000Z',
      domain: null,
    },
  ],
  ...overrides,
});

const pending = {
  domain: {
    id: 'd-1',
    origin: SHOP,
    registrableDomain: 'cantina.example',
    status: 'PENDING' as const,
    kind: 'production' as const,
    verificationToken: 'token-built-at-runtime',
    verificationExpiresAt: '2026-10-15T00:00:00.000Z',
    createdAt: '2026-10-01T15:30:00.000Z',
  },
  created: true,
};

const mount = (
  canAdd: boolean,
  read: RefusedOriginsResponse | Error = answer(),
  add: Route = () => Promise.resolve(pending),
) => {
  const { client, request } = fakeClient({
    'GET /v1/dashboard/analytics/origins': () =>
      read instanceof Error ? Promise.reject(read) : Promise.resolve(read),
    'POST /v1/dashboard/domains': add,
  });

  render(<RefusedOriginsPanel client={client} range={RANGE} canAdd={canAdd} />);

  return { request };
};

const rowOf = async (origin: string): Promise<HTMLElement> => {
  const header = await screen.findByRole('rowheader', { name: origin });
  return header.closest('tr') as HTMLElement;
};

describe('the panel', () => {
  it('leads with the fix, not with theft', async () => {
    mount(true);

    const panel = await screen.findByRole('region', { name: 'Siti non autorizzati' });
    const lead = panel.querySelector('p')?.textContent ?? '';

    expect(lead.startsWith('Hai cambiato dominio')).toBe(true);
    expect(panel.textContent).not.toMatch(/furto|rubat|attacc/iu);
  });

  it('shows each site with its attempts, its visitors and when last', async () => {
    mount(true);

    const cells = [...(await rowOf(SHOP)).querySelectorAll('th, td')].map((cell) =>
      cell.textContent?.trim(),
    );

    expect(cells.slice(0, 4)).toEqual([SHOP, '212', '37', '30 settembre 2026']);
  });

  it('says so when no site was refused', async () => {
    mount(true, answer({ origins: [] }));

    expect(
      await screen.findByText(
        'Nessun sito non autorizzato ha provato a usare il widget in questo periodo.',
      ),
    ).toBeTruthy();
  });

  it('says it could not read them, rather than showing nothing', async () => {
    mount(true, new Error('down'));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Non è stato possibile leggere i siti rifiutati.',
    );
  });
});

describe('the one-click add', () => {
  it('posts the site to the ordinary domains route, and nothing else', async () => {
    const { request } = mount(true);

    fireEvent.click(within(await rowOf(SHOP)).getByRole('button', { name: 'È mio, aggiungilo' }));

    await screen.findByText(/in attesa di verifica/u, { selector: `tr:first-child span` });
    expect(request).toHaveBeenCalledWith('POST /v1/dashboard/domains', {
      body: { domain: SHOP, kind: 'production' },
    });
    expect(request.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      'GET /v1/dashboard/analytics/origins',
      'POST /v1/dashboard/domains',
    ]);
  });

  it('shows the site as waiting for verification, with the way to finish it', async () => {
    mount(true);

    const row = await rowOf(SHOP);

    fireEvent.click(within(row).getByRole('button', { name: 'È mio, aggiungilo' }));

    expect(await within(row).findByText(/Aggiunto, in attesa di verifica/u)).toBeTruthy();
    expect(
      within(row).getByRole('link', { name: 'Completa la verifica' }).getAttribute('href'),
    ).toBe('/domini');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('says what the API said when the add is refused', async () => {
    mount(true, answer(), () =>
      Promise.reject(new ApiError(409, 'conflict', 'That domain is not available.', 'req-1')),
    );

    const row = await rowOf(SHOP);

    fireEvent.click(within(row).getByRole('button', { name: 'È mio, aggiungilo' }));

    expect((await within(row).findByRole('alert')).textContent).toContain(
      'That domain is not available.',
    );
  });

  it('does not offer to add a site already added, and says how far it got', async () => {
    mount(true);

    const row = await rowOf('https://www.cantina.example');

    expect(within(row).queryByRole('button')).toBeNull();
    expect(row.textContent).toContain('in attesa di verifica');
  });

  it('does not offer to add what is not a web address', async () => {
    mount(true);

    const row = await rowOf('null');

    expect(within(row).queryByRole('button')).toBeNull();
    expect(row.textContent).toContain('Non è un sito che si possa aggiungere');
  });

  it('is not offered to a member who cannot add a domain, who is told whom to ask', async () => {
    mount(false);

    const row = await rowOf(SHOP);

    expect(within(row).queryByRole('button')).toBeNull();
    expect(row.textContent).toContain('chiedi a un titolare');
  });
});
