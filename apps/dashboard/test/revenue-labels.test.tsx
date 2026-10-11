import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SalesResponse } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { AnalyticsScreen } from '../src/features/analytics/AnalyticsScreen.js';
import {
  attributionOf,
  CART_LABEL,
  money,
  revenueLabels,
  SALES_LABEL,
} from '../src/features/analytics/labels.js';
import { fakeClient } from './support/client.js';

/**
 * No sale is claimed that was not seen (P6-10, §2.4).
 *
 * **The guard is the absence of a word.** Until a winery's Shopify store is
 * connected, every number the dashboard has stops at the cart; "Vendite" above
 * any of them would be a false claim to a paying customer, contradicted by
 * their own order list. So the screen is rendered whole, in every state where
 * a sale cannot be seen, and searched.
 *
 * And because a search of what one test rendered cannot see a panel nobody
 * rendered, the folder is read as well: the word is written in `labels.ts`
 * and nowhere else, so a panel added later has nowhere to get it but there.
 */

afterEach(cleanup);

const NOW = new Date('2026-10-01T15:30:00.000Z');
const RANGE = { from: '2026-09-02', to: '2026-10-01' };

/** Any word that claims money was made. */
const CLAIMS_A_SALE = /\bvendit[ae]\b|\bvendut[oaie]\b|fatturato|ricav[oi]|incass/iu;

const sold = (overrides: Partial<SalesResponse> = {}): SalesResponse => ({
  ...RANGE,
  hasOrderAttribution: true,
  orders: 31,
  visits: 29,
  units: 74,
  amounts: [{ currency: 'EUR', cents: 286_450 }],
  ...overrides,
});

const notMeasured: SalesResponse = {
  ...RANGE,
  hasOrderAttribution: false,
  orders: 0,
  visits: 0,
  units: 0,
  amounts: [],
};

/** The screen with every panel answering, and sales answering as the test says. */
const mount = (sales: () => Promise<SalesResponse>) => {
  const fake = fakeClient({
    'GET /v1/dashboard/analytics/sales': sales,
    'GET /v1/dashboard/analytics/funnel': () =>
      Promise.resolve({
        ...RANGE,
        stages: [
          { stage: 'WIDGET_OPEN', sessions: 1_200, rate: null },
          { stage: 'MESSAGE_SENT', sessions: 480, rate: 0.4 },
          { stage: 'RECOMMENDATION_SHOWN', sessions: 360, rate: 0.75 },
          { stage: 'ADD_TO_CART', sessions: 45, rate: 0.125 },
        ],
      }),
    'GET /v1/dashboard/analytics/top': () =>
      Promise.resolve({
        ...RANGE,
        queries: [
          { query: 'prosecco?', conversations: 21, lastAskedAt: '2026-09-30T19:12:00.000Z' },
        ],
        products: [
          {
            productId: '9b2f4c1e-6a3d-4e8b-9f10-2c7d5e8a1b34',
            name: 'Barolo',
            archived: false,
            recommended: 1_040,
            addedToCart: 156,
            rate: 0.15,
          },
        ],
      }),
    'GET /v1/dashboard/analytics/zero-results': () =>
      Promise.resolve({
        ...RANGE,
        conversations: 3,
        themes: [{ id: 'price', label: 'Prezzo', conversations: 2 }],
        questions: [
          {
            question: 'avete il Sassicaia 2015?',
            kind: 'no_match',
            conversations: 2,
            lastAskedAt: '2026-09-30T19:12:00.000Z',
          },
        ],
      }),
    'GET /v1/dashboard/analytics/origins': () =>
      Promise.resolve({
        ...RANGE,
        origins: [
          {
            origin: 'https://shop.cantina.example',
            attempts: 212,
            sources: 37,
            lastSeenAt: '2026-09-30T19:12:00.000Z',
            domain: null,
          },
        ],
      }),
  });

  render(<AnalyticsScreen client={fake.client} now={() => NOW} />);

  return fake;
};

/** Every panel has drawn what it was given: the last ones to arrive are on screen. */
const everyPanel = async (): Promise<void> => {
  await screen.findByRole('region', { name: 'Vini più consigliati' });
  await screen.findByText('Aggiunte al carrello', { selector: 'th[scope="row"]' });
  await screen.findByText('https://shop.cantina.example');
};

const never = (): Promise<SalesResponse> => new Promise(() => undefined);

describe('the words', () => {
  it('call a click an add to cart whatever else is known', () => {
    for (const flag of [true, false, undefined]) {
      expect(revenueLabels(flag).cart).toBe('Aggiunte al carrello');
    }

    expect(CART_LABEL).toBe('Aggiunte al carrello');
  });

  it('name sales only when the API has said a sale can be seen', () => {
    expect(revenueLabels(true).sales).toBe('Vendite');
    expect(revenueLabels(false).sales).toBeUndefined();
    expect(revenueLabels(undefined).sales).toBeUndefined();
    expect(SALES_LABEL).toBe('Vendite');
  });

  it('offer the Shopify connection only when the API has said none is connected', () => {
    expect(revenueLabels(false).offerShopify).toBe(true);
    /* Still loading, or unreadable: not a reason to tell a connected seller to connect. */
    expect(revenueLabels(undefined).offerShopify).toBe(false);
    expect(revenueLabels(true).offerShopify).toBe(false);
  });

  it('claim no sale in the note unless one can be seen', () => {
    expect(revenueLabels(false).note).not.toMatch(CLAIMS_A_SALE);
    expect(revenueLabels(undefined).note).not.toMatch(CLAIMS_A_SALE);
    /* And say, in every case, what the last step actually is. */
    for (const flag of [true, false, undefined]) {
      expect(revenueLabels(flag).note).toContain('aggiunta al carrello, non un ordine');
    }
  });

  it('read the flag from the API’s answer, and nothing before there is one', () => {
    expect(attributionOf(undefined)).toBeUndefined();
    expect(attributionOf(notMeasured)).toBe(false);
    expect(attributionOf(sold())).toBe(true);
  });

  it('write an amount as an Italian reads one', () => {
    expect(money({ currency: 'EUR', cents: 286_450 }).replaceAll(/\s/gu, ' ')).toBe('2.864,50 €');
    expect(money({ currency: 'EUR', cents: 5 }).replaceAll(/\s/gu, ' ')).toBe('0,05 €');
    expect(money({ currency: 'CHF', cents: 12_000 })).toContain('120,00');
  });
});

describe('a winery whose orders are not seen', () => {
  it('is shown no word that claims a sale, on any panel', async () => {
    mount(() => Promise.resolve(notMeasured));
    await everyPanel();
    await screen.findByRole('link', { name: 'Collega il tuo negozio Shopify' });

    expect(document.body.textContent).not.toMatch(CLAIMS_A_SALE);
    expect(screen.queryByRole('region', { name: 'Vendite' })).toBeNull();
  });

  it('is shown the noughts nowhere: unmeasured is not none sold', async () => {
    mount(() => Promise.resolve(notMeasured));
    await everyPanel();
    await screen.findByRole('link', { name: 'Collega il tuo negozio Shopify' });

    expect(document.body.textContent).not.toMatch(/Ordini\s*0|Bottiglie\s*0|0,00/u);
    expect(document.body.textContent).not.toContain('Nessun ordine');
  });

  it('is told what the last step is, and offered the way to see more', async () => {
    mount(() => Promise.resolve(notMeasured));
    await everyPanel();

    const funnel = screen.getByRole('region', { name: 'Percorso dei visitatori' });
    const offer = await within(funnel).findByRole('link', {
      name: 'Collega il tuo negozio Shopify',
    });

    expect(offer.getAttribute('href')).toBe('/integrazioni');
    expect(funnel.textContent).toContain('un’aggiunta al carrello, non un ordine');
  });
});

describe('a winery the screen has not been told about', () => {
  it('is shown no word that claims a sale while the answer is still coming', async () => {
    mount(never);
    await everyPanel();

    expect(document.body.textContent).not.toMatch(CLAIMS_A_SALE);
    expect(screen.queryByRole('region', { name: 'Vendite' })).toBeNull();
    /* Nor told to connect a shop it may already have connected. */
    expect(screen.queryByRole('link', { name: 'Collega il tuo negozio Shopify' })).toBeNull();
  });

  it('is shown none when the answer could not be read', async () => {
    mount(() => Promise.reject(new Error('down')));
    await everyPanel();

    expect(document.body.textContent).not.toMatch(CLAIMS_A_SALE);
    expect(screen.queryByRole('link', { name: 'Collega il tuo negozio Shopify' })).toBeNull();
  });
});

describe('a winery whose orders are seen', () => {
  it('is shown what the sommelier sold, under the word for it', async () => {
    mount(() => Promise.resolve(sold()));

    const panel = await screen.findByRole('region', { name: 'Vendite' });
    const read = [...panel.querySelectorAll('dt')].map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent?.replaceAll(/\s/gu, ' '),
    ]);

    expect(read).toEqual([
      ['Ordini', '31'],
      ['Visite che hanno comprato', '29'],
      ['Bottiglie', '74'],
      ['Valore', '2.864,50 €'],
    ]);
  });

  it('is told what is counted: our lines only, and after refunds', async () => {
    mount(() => Promise.resolve(sold()));

    const panel = await screen.findByRole('region', { name: 'Vendite' });

    expect(panel.textContent).toContain('non il resto dell');
    expect(panel.textContent).toContain('togliamo i resi');
  });

  it('still calls the funnel’s last step an add to cart', async () => {
    mount(() => Promise.resolve(sold()));
    await screen.findByRole('region', { name: 'Vendite' });
    await everyPanel();

    const funnel = screen.getByRole('region', { name: 'Percorso dei visitatori' });

    expect(funnel.querySelectorAll('tbody th')[3]?.textContent).toBe('Aggiunte al carrello');
    expect(funnel.textContent).not.toMatch(CLAIMS_A_SALE);
    expect(
      within(funnel).queryByRole('link', { name: 'Collega il tuo negozio Shopify' }),
    ).toBeNull();
  });

  it('is told there were none, rather than shown a list of noughts', async () => {
    mount(() => Promise.resolve(sold({ orders: 0, visits: 0, units: 0, amounts: [] })));

    const panel = await screen.findByRole('region', { name: 'Vendite' });

    expect(panel.textContent).toContain('Nessun ordine con un vino consigliato');
    expect(panel.querySelector('dl')).toBeNull();
  });

  it('is shown each currency on its own, never added together', async () => {
    mount(() =>
      Promise.resolve(
        sold({
          amounts: [
            { currency: 'EUR', cents: 286_450 },
            { currency: 'CHF', cents: 12_000 },
          ],
        }),
      ),
    );

    const panel = await screen.findByRole('region', { name: 'Vendite' });
    const value = [...panel.querySelectorAll('dd')].at(-1)?.textContent ?? '';

    expect(value.replaceAll(/\s/gu, ' ')).toMatch(/^2\.864,50 € \+ .*120,00/u);
  });
});

describe('the range', () => {
  it('is asked of sales as of every other panel, and again when it changes', async () => {
    const { request } = mount(() => Promise.resolve(sold()));

    await screen.findByRole('region', { name: 'Vendite' });
    expect(request).toHaveBeenCalledWith('GET /v1/dashboard/analytics/sales', {
      query: { from: '2026-09-02', to: '2026-10-01' },
    });

    fireEvent.change(screen.getByRole('combobox', { name: /Periodo/u }), {
      target: { value: '7' },
    });

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('GET /v1/dashboard/analytics/sales', {
        query: { from: '2026-09-25', to: '2026-10-01' },
      });
    });
  });

  it('takes the panel away while a new range is being read, rather than showing the old one', async () => {
    let answers = 0;

    mount(() => {
      answers += 1;

      return answers === 1 ? Promise.resolve(sold()) : never();
    });
    await screen.findByRole('region', { name: 'Vendite' });

    fireEvent.change(screen.getByRole('combobox', { name: /Periodo/u }), {
      target: { value: '7' },
    });

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Vendite' })).toBeNull();
    });
  });
});

describe('where the word is written', () => {
  it('is one file: no panel has a revenue word of its own', () => {
    /*
     * What the tests above cannot see is a panel nobody rendered. A file in
     * this folder that says "Vendite" for itself has stopped asking the one
     * function, and will say it to a winery whose orders were never seen.
     */
    const folder = join(import.meta.dirname, '..', 'src', 'features', 'analytics');
    const files = readdirSync(folder).filter((name) => /\.tsx?$/u.test(name));
    const saying = files.filter((name) =>
      CLAIMS_A_SALE.test(readFileSync(join(folder, name), 'utf8')),
    );

    expect(files).toContain('labels.ts');
    expect(files.length).toBeGreaterThan(3);
    expect(saying).toEqual(['labels.ts']);
  });
});
