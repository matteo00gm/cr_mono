import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { Layout } from '../src/app.js';
import { ClaimNotice, formatTransfer } from '../src/features/domains/ClaimNotice.js';
import type { SessionState } from '../src/session.js';
import { fakeClient } from './support/client.js';

/**
 * The banner for a claim on one of this winery's domains (P4-18b).
 *
 * What it shows, the one click it offers, and — as much as either — when it
 * shows nothing: no claims, a failed load, a role or a session that could not
 * act on it anyway.
 */

afterEach(cleanup);

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLAIM = {
  id: 'c9',
  origin: 'https://www.cantina.example',
  transferAt: '2026-10-03T08:00:00.000Z',
};

const served = (claims: readonly (typeof CLAIM)[] = [CLAIM]) =>
  fakeClient({
    'GET /v1/dashboard/domains/claims/served': () => Promise.resolve({ claims }),
    'POST /v1/dashboard/domains/claims/:id/withdraw': (init) =>
      Promise.resolve({ id: init?.params?.id, origin: CLAIM.origin, withdrawn: true }),
  });

describe('the claim banner', () => {
  it('names the domain and when it moves, and nothing about the claimant', async () => {
    render(<ClaimNotice client={served().client} />);

    const banner = await screen.findByRole('alert', { name: 'Richieste sui tuoi domini' });

    expect(banner.textContent).toContain('https://www.cantina.example');
    expect(banner.textContent).toContain(formatTransfer(CLAIM.transferAt));
  });

  it('withdraws in one click, and the banner goes', async () => {
    const { client, request } = served();
    render(<ClaimNotice client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ritira la richiesta' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(request).toHaveBeenCalledWith('POST /v1/dashboard/domains/claims/:id/withdraw', {
      params: { id: 'c9' },
    });
  });

  it('says so when the withdrawal fails, and keeps the claim on screen', async () => {
    const { client } = fakeClient({
      'GET /v1/dashboard/domains/claims/served': () => Promise.resolve({ claims: [CLAIM] }),
      'POST /v1/dashboard/domains/claims/:id/withdraw': () => Promise.reject(new Error('down')),
    });
    render(<ClaimNotice client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ritira la richiesta' }));

    expect(await screen.findByText(/Non è stato possibile ritirare la richiesta/u)).toBeTruthy();
    expect(screen.getByText('https://www.cantina.example')).toBeTruthy();
  });

  it('shows nothing when there is no claim, or the list could not be read', async () => {
    const { client: none, request: asked } = served([]);
    const { client: broken, request: failed } = fakeClient({
      'GET /v1/dashboard/domains/claims/served': () => Promise.reject(new Error('down')),
    });

    const { container: empty } = render(<ClaimNotice client={none} />);
    const { container: failing } = render(<ClaimNotice client={broken} />);

    await waitFor(() => {
      expect(asked).toHaveBeenCalled();
      expect(failed).toHaveBeenCalled();
    });
    expect(empty.innerHTML).toBe('');
    expect(failing.innerHTML).toBe('');
  });
});

describe('where the shell mounts it', () => {
  const session = (
    role: 'OWNER' | 'EDITOR',
    twoFactorEnabled = true,
  ): Extract<SessionState, { status: 'signed-in' }> => ({
    status: 'signed-in',
    userId: 'user_matteo',
    twoFactorEnabled,
    memberships: [{ tenantId: TENANT, role }],
    active: { tenantId: TENANT, role },
  });

  it('shows it to an owner with a second factor', async () => {
    const { client } = served();
    render(<Layout session={session('OWNER')} clientFor={() => client} />);

    expect(await screen.findByRole('alert', { name: 'Richieste sui tuoi domini' })).toBeTruthy();
  });

  it.each([
    ['an editor', session('EDITOR')],
    ['an owner who cannot use the domain routes yet', session('OWNER', false)],
  ])('does not even ask for %s', (_label, signedIn) => {
    const { client, request } = served();
    render(<Layout session={signedIn} clientFor={() => client} />);

    /* The claims, specifically: the shell's billing banner reads the month for every role (P5-12). */
    expect(request.mock.calls.map(([endpoint]) => endpoint)).not.toContain(
      'GET /v1/dashboard/domains/claims/served',
    );
  });
});
