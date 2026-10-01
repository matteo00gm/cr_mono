import type { UsageResponse } from '@catalogorosso/api-client';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { Layout } from '../src/app.js';
import { BillingBanner } from '../src/features/billing/BillingBanner.js';
import type { SessionState } from '../src/session.js';
import { fakeClient } from './support/client.js';

/**
 * The banner across every screen (P5-12, §2.3, §2.5): what each role is shown
 * when the month runs low, when it is spent, and when a payment failed — and
 * that it shows nothing otherwise, or when it could not read the month.
 */

afterEach(cleanup);

const TENANT = '11111111-1111-1111-1111-111111111111';

const usage = (overrides: Partial<UsageResponse> = {}): UsageResponse => ({
  period: '202610',
  resetsAt: '2026-11-01T00:00:00.000Z',
  plan: 'CANTINA',
  status: 'ACTIVE',
  used: 600,
  included: 1_500,
  purchased: 0,
  allowance: 1_500,
  state: 'ok',
  projected: 900,
  byDay: [],
  byOrigin: [],
  ...overrides,
});

const reading = (answer: UsageResponse) =>
  fakeClient({ 'GET /v1/dashboard/usage': () => Promise.resolve(answer) });

const NEAR = usage({ used: 1_200, state: 'near' });
const SPENT = usage({ used: 1_500, state: 'exceeded' });

describe('for an owner', () => {
  it('names how much of the month is gone, with both ways out, when it runs low', async () => {
    render(<BillingBanner client={reading(NEAR).client} role="OWNER" />);

    const banner = await screen.findByRole('status', { name: 'Messaggi del mese' });

    expect(banner.textContent).toContain('Hai usato l’80% dei messaggi del mese.');
    expect(
      screen.getByRole('link', { name: 'Acquista Ricarica +1.000 messaggi (€15)' }),
    ).toHaveProperty('href', expect.stringContaining('/fatturazione#ricarica'));
    expect(
      screen.getByRole('link', { name: 'Passa al piano E-commerce (€79/mese)' }),
    ).toHaveProperty('href', expect.stringContaining('/fatturazione#piano'));
  });

  it('says the widget is quiet, and until when, once the month is spent', async () => {
    render(<BillingBanner client={reading(SPENT).client} role="OWNER" />);

    const banner = await screen.findByRole('alert', { name: 'Messaggi del mese' });

    expect(banner.textContent).toContain(
      'il sommelier non risponde ai visitatori fino al 1 novembre 2026',
    );
    expect(screen.getByRole('link', { name: /Acquista Ricarica/u })).toBeTruthy();
  });

  it('offers the top-up alone on the top plan', async () => {
    render(<BillingBanner client={reading({ ...SPENT, plan: 'ECOMMERCE' }).client} role="OWNER" />);

    await screen.findByRole('alert');

    expect(screen.queryByRole('link', { name: /Passa al piano/u })).toBeNull();
    expect(screen.getByRole('link', { name: /Acquista Ricarica/u })).toBeTruthy();
  });

  it('offers a plan alone to a winery with none, which a top-up cannot be added to', async () => {
    render(<BillingBanner client={reading({ ...SPENT, plan: null }).client} role="OWNER" />);

    await screen.findByRole('alert');

    expect(screen.queryByRole('link', { name: /Ricarica/u })).toBeNull();
    expect(screen.getByRole('link', { name: 'Passa al piano Cantina (€29/mese)' })).toBeTruthy();
  });

  it('leads with the fix when a payment failed (§2.5)', async () => {
    render(
      <BillingBanner client={reading({ ...SPENT, status: 'PAST_DUE' }).client} role="OWNER" />,
    );

    const banner = await screen.findByRole('alert', { name: 'Pagamento' });

    expect(banner.textContent).toContain(
      'Il pagamento non è riuscito e il widget è disattivato. Aggiorna il metodo di pagamento',
    );
    expect(screen.getByRole('link', { name: 'Aggiorna il pagamento' })).toBeTruthy();
  });
});

describe('for an editor', () => {
  it.each([
    ['the month running low', NEAR, 'Avvisa un titolare della cantina prima che finiscano.'],
    ['the month spent', SPENT, 'Avvisa un titolare della cantina: può acquistare una ricarica'],
    [
      'a failed payment',
      usage({ status: 'PAST_DUE' }),
      'Avvisa un titolare della cantina: solo lui può aggiornare il pagamento.',
    ],
  ])(
    'says what is happening for %s, asks them to tell an owner, and offers no button',
    async (_what, answer, ask) => {
      const { container } = render(<BillingBanner client={reading(answer).client} role="EDITOR" />);

      await waitFor(() => {
        expect(container.textContent).toContain(ask);
      });
      expect(screen.queryAllByRole('link')).toEqual([]);
    },
  );
});

describe('nothing', () => {
  it('is shown with room left in the month', async () => {
    const { client, request } = reading(usage());
    const { container } = render(<BillingBanner client={client} role="OWNER" />);

    await waitFor(() => {
      expect(request).toHaveBeenCalled();
    });
    expect(container.innerHTML).toBe('');
  });

  it('is shown when the month could not be read', async () => {
    const { client, request } = fakeClient({
      'GET /v1/dashboard/usage': () => Promise.reject(new Error('down')),
    });
    const { container } = render(<BillingBanner client={client} role="OWNER" />);

    await waitFor(() => {
      expect(request).toHaveBeenCalled();
    });
    expect(container.innerHTML).toBe('');
  });
});

describe('in the shell', () => {
  const session = (role: 'OWNER' | 'EDITOR'): Extract<SessionState, { status: 'signed-in' }> => ({
    status: 'signed-in',
    userId: 'user_1',
    twoFactorEnabled: true,
    memberships: [{ tenantId: TENANT, role }],
    active: { tenantId: TENANT, role },
  });

  it.each(['OWNER', 'EDITOR'] as const)('is shown to %s, above every screen', async (role) => {
    const { client } = fakeClient({
      'GET /v1/dashboard/usage': () => Promise.resolve(SPENT),
      'GET /v1/dashboard/domains/claims/served': () => Promise.resolve({ claims: [] }),
    });

    render(<Layout session={session(role)} clientFor={() => client} />);

    expect(await screen.findByRole('alert', { name: 'Messaggi del mese' })).toBeTruthy();
  });
});
