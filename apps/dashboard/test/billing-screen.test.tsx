import { ApiError, type UsageResponse } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BillingScreen, UsageMeter } from '../src/features/billing/BillingScreen.js';
import { fakeClient, type Route } from './support/client.js';

/**
 * Fatturazione (P5-12, §2.3, §2.5): the meter, and every button asking the
 * API and sending the owner where it answers — or saying, in the API's own
 * words, why not.
 */

afterEach(cleanup);

const usage = (overrides: Partial<UsageResponse> = {}): UsageResponse => ({
  period: '202610',
  resetsAt: '2026-11-01T00:00:00.000Z',
  plan: 'CANTINA',
  status: 'ACTIVE',
  used: 1_230,
  included: 1_500,
  purchased: 0,
  allowance: 1_500,
  state: 'near',
  projected: 1_810,
  byDay: [{ day: '2026-10-01', messages: 58 }],
  byOrigin: [
    { origin: 'https://www.cantina.example', messages: 1_200 },
    { origin: null, messages: 30 },
  ],
  ...overrides,
});

const screenWith = (answer: UsageResponse, routes: Readonly<Record<string, Route>> = {}) => {
  const go = vi.fn();
  const { client, request } = fakeClient({
    'GET /v1/dashboard/usage': () => Promise.resolve(answer),
    ...routes,
  });

  render(<BillingScreen client={client} go={go} search="" />);

  return { go, request };
};

describe('the meter', () => {
  it('shows the month against the allowance, and where it is heading', () => {
    render(<UsageMeter usage={usage()} />);

    const meter = screen.getByRole('region', { name: 'Messaggi del mese' });

    expect(meter.textContent).toContain('1.230 di 1.500 messaggi usati questo mese');
    expect(meter.textContent).toContain('Proiezione a fine mese: 1.810.');
    expect(meter.textContent).toContain('Si azzerano il 1 novembre 2026.');
    /* Not by role: the test DOM gives `<meter>` none, where a browser does. */
    expect(meter.querySelector('meter')).toHaveProperty('value', 1_230);
  });

  it('says how much of the allowance was bought', () => {
    render(<UsageMeter usage={usage({ purchased: 1_000, allowance: 2_500 })} />);

    expect(screen.getByRole('region').textContent).toContain(
      'Comprende 1.000 messaggi da ricariche.',
    );
  });
});

describe('the screen', () => {
  it('breaks the month down by day and by site', async () => {
    screenWith(usage());

    expect(await screen.findByRole('table', { name: 'Per giorno' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Per sito' }).textContent).toContain('Senza sito');
  });

  it('sends the owner to Stripe for a top-up', async () => {
    const { go, request } = screenWith(usage(), {
      'POST /v1/dashboard/billing/top-up': () =>
        Promise.resolve({ url: 'https://checkout.stripe.com/c/pay/cs_top_up' }),
    });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Acquista Ricarica +1.000 messaggi (€15)' }),
    );

    await waitFor(() => {
      expect(go).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_top_up');
    });
    expect(request).toHaveBeenCalledWith('POST /v1/dashboard/billing/top-up');
  });

  it('offers no top-up while a payment is overdue', async () => {
    screenWith(usage({ status: 'PAST_DUE' }));

    await screen.findByRole('heading', { name: /Piano Cantina/u });

    expect(screen.queryByRole('button', { name: /Ricarica/u })).toBeNull();
  });

  it('asks for a fresh second factor before a plan change, then makes it', async () => {
    let fresh = false;
    const plans: unknown[] = [];
    const go = vi.fn();
    const { client } = fakeClient({
      'GET /v1/dashboard/usage': () => Promise.resolve(usage()),
      'POST /v1/dashboard/billing/plan': (init) => {
        plans.push(init?.body);

        return fresh
          ? Promise.resolve({ plan: 'ECOMMERCE', effective: 'now', effectiveAt: null })
          : Promise.reject(new ApiError(403, 'step_up_required', 'Confirm it is you.', 'r1'));
      },
    });
    const twoFactor = {
      enable: () => Promise.reject(new Error('not this')),
      verifyTotp: () => {
        fresh = true;
        return Promise.resolve();
      },
      verifyBackupCode: () => Promise.reject(new Error('not this')),
    };

    render(<BillingScreen client={client} go={go} search="" twoFactor={twoFactor} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Passa al piano E-commerce (€79/mese)' }),
    );
    expect(await screen.findByRole('dialog', { name: 'Conferma che sei tu' })).toBeTruthy();

    fireEvent.input(screen.getByLabelText('Codice'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));

    expect((await screen.findByRole('status')).textContent).toContain(
      'Passaggio a E-commerce richiesto',
    );
    expect(plans).toEqual([{ plan: 'ECOMMERCE' }, { plan: 'ECOMMERCE' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says what the API said when it refuses, word for word', async () => {
    const refusal =
      'Cantina allows 300 wines and 1 domain. To move to Cantina, archive 112 wines (412 of 300) first.';

    screenWith(usage({ plan: 'ECOMMERCE', allowance: 6_000, included: 6_000 }), {
      'POST /v1/dashboard/billing/plan': () =>
        Promise.reject(new ApiError(409, 'conflict', refusal, 'r2')),
    });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Passa al piano Cantina dal prossimo rinnovo' }),
    );

    expect((await screen.findByRole('alert')).textContent).toBe(refusal);
  });

  it('lets a winery with no plan choose one, on Stripe’s page', async () => {
    const { go, request } = screenWith(usage({ plan: null, status: 'TRIALING' }), {
      'POST /v1/dashboard/billing/checkout': () =>
        Promise.resolve({ url: 'https://checkout.stripe.com/c/pay/cs_plan' }),
    });

    fireEvent.click(await screen.findByRole('button', { name: /^Cantina — €29\/mese/u }));

    await waitFor(() => {
      expect(go).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_plan');
    });
    expect(request).toHaveBeenCalledWith('POST /v1/dashboard/billing/checkout', {
      body: { plan: 'CANTINA' },
    });
  });

  it('thanks the owner on the way back from Stripe, without claiming it is done', async () => {
    const { client } = fakeClient({
      'GET /v1/dashboard/usage': () => Promise.resolve(usage()),
    });

    render(<BillingScreen client={client} go={vi.fn()} search="?top_up=success" />);

    expect((await screen.findByRole('status')).textContent).toBe(
      'Grazie: i messaggi si aggiungono appena Stripe conferma il pagamento.',
    );
  });

  it('says so when the month could not be read', async () => {
    const { client } = fakeClient({
      'GET /v1/dashboard/usage': () => Promise.reject(new Error('down')),
    });

    render(<BillingScreen client={client} go={vi.fn()} search="" />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Non è stato possibile leggere i consumi.',
    );
  });
});
