import { ApiError, type ShopifyStatusResponse } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_NOTICES,
  IntegrationsScreen,
  RETURN_NOTICES,
  returnNotice,
} from '../src/features/integrations/IntegrationsScreen.js';
import { fakeClient, type Route } from './support/client.js';

/**
 * Integrazioni (P6-06): the Shopify status, the connect form, and what the
 * owner is told when Shopify sends them back.
 */

afterEach(cleanup);

const SHOP = 'cantina-rossi.myshopify.com';

const mount = (
  status: ShopifyStatusResponse | Error,
  {
    canConnect = true,
    search = '',
    install = () => Promise.resolve({ url: `https://${SHOP}/admin/oauth/authorize?state=x` }),
  }: { canConnect?: boolean; search?: string; install?: Route } = {},
) => {
  const go = vi.fn();
  const { client, request } = fakeClient({
    'GET /v1/dashboard/shopify': () =>
      status instanceof Error ? Promise.reject(status) : Promise.resolve(status),
    'POST /v1/dashboard/shopify/install': install,
  });

  render(<IntegrationsScreen client={client} canConnect={canConnect} search={search} go={go} />);

  return { go, request };
};

const NOTHING_YET: ShopifyStatusResponse = { configured: true, shop: null };

describe('the status', () => {
  it('says so when Shopify is not set up on this service, and offers nothing', async () => {
    mount({ configured: false, shop: null });

    expect(
      await screen.findByText('Shopify non è ancora disponibile su questo servizio.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says which shop is connected, and since when, without offering to connect again', async () => {
    mount({
      configured: true,
      shop: { shop: SHOP, installedAt: '2026-10-02T09:00:00.000Z', uninstalledAt: null },
    });

    const section = await screen.findByRole('region', { name: 'Shopify' });

    await waitFor(() => {
      expect(section.textContent).toContain(`Collegato a ${SHOP} dal 2 ottobre 2026.`);
    });
    expect(screen.queryByRole('button', { name: 'Collega Shopify' })).toBeNull();
  });

  it('says when the app was uninstalled, and offers to connect again', async () => {
    mount({
      configured: true,
      shop: {
        shop: SHOP,
        installedAt: '2026-10-02T09:00:00.000Z',
        uninstalledAt: '2026-10-03T09:00:00.000Z',
      },
    });

    expect(await screen.findByText(/disinstallata/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collega Shopify' })).toBeTruthy();
  });

  it('says it could not read the status', async () => {
    mount(new Error('down'));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Non è stato possibile leggere lo stato.',
    );
  });
});

describe('connecting', () => {
  it('asks the API for the consent URL for the shop typed, and sends the owner there', async () => {
    const { go, request } = mount(NOTHING_YET);
    const input = await screen.findByRole('textbox', { name: /Il tuo negozio Shopify/u });

    fireEvent.input(input, { target: { value: 'cantina-rossi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Collega Shopify' }));

    await waitFor(() => {
      expect(go).toHaveBeenCalledWith(`https://${SHOP}/admin/oauth/authorize?state=x`);
    });
    expect(request).toHaveBeenCalledWith('POST /v1/dashboard/shopify/install', {
      body: { shop: 'cantina-rossi' },
    });
  });

  it('cannot be sent empty', async () => {
    mount(NOTHING_YET);

    expect(
      (await screen.findByRole('button', { name: 'Collega Shopify' })).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('says what the API said when it refuses, and stays on the page', async () => {
    const { go } = mount(NOTHING_YET, {
      install: () =>
        Promise.reject(new ApiError(422, 'invalid', 'Give your Shopify store as…', 'req-1')),
    });
    const input = await screen.findByRole('textbox', { name: /Il tuo negozio Shopify/u });

    fireEvent.input(input, { target: { value: 'www.cantina.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Collega Shopify' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Give your Shopify store as…');
    expect(go).not.toHaveBeenCalled();
  });

  it('is not offered to a member who cannot connect a store, who is told whom to ask', async () => {
    mount(NOTHING_YET, { canConnect: false });

    expect(await screen.findByText('Chiedi a un titolare di collegare il negozio.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('coming back from Shopify', () => {
  it('says the store is connected, and what became of its address', () => {
    expect(returnNotice('?shopify=collegato&dominio=verificato')).toEqual({
      ok: true,
      text: `Negozio collegato. ${DOMAIN_NOTICES.verificato ?? ''}`,
    });
    expect(returnNotice('?shopify=collegato')).toEqual({ ok: true, text: 'Negozio collegato.' });
  });

  it.each(Object.keys(RETURN_NOTICES))('explains a refusal for %s', (reason) => {
    expect(returnNotice(`?shopify=errore&motivo=${reason}`)).toEqual({
      ok: false,
      text: RETURN_NOTICES[reason],
    });
  });

  it('says something useful for a reason it does not know', () => {
    expect(returnNotice('?shopify=errore&motivo=altro')?.text).toBe(
      'Il collegamento non è riuscito. Riprova fra un momento.',
    );
  });

  it('says nothing on an ordinary visit', () => {
    expect(returnNotice('')).toBeUndefined();
    expect(returnNotice('?foo=bar')).toBeUndefined();
  });

  it('shows a refusal as an alert and a success as a status', async () => {
    mount(NOTHING_YET, { search: '?shopify=errore&motivo=scaduto' });

    expect((await screen.findByRole('alert')).textContent).toBe(RETURN_NOTICES.scaduto);

    cleanup();
    mount(NOTHING_YET, { search: '?shopify=collegato&dominio=limite' });

    expect((await screen.findByRole('status')).textContent).toContain('Negozio collegato.');
  });
});
