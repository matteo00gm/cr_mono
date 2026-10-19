import { ApiError, type KeysResponse } from '@catalogorosso/api-client';
import { installSnippet, LOADER_SRC } from '@catalogorosso/core/install-snippet';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COPIED, WidgetScreen } from '../src/features/widget/WidgetScreen.js';
import { fakeClient, type Route } from './support/client.js';

/**
 * Widget (P4-09b): the keys a winery could not see, the snippet it could not
 * copy, and the one moment a secret key is readable.
 */

afterEach(cleanup);

/** Built at runtime, never written as a key-shaped literal (P0-56). */
const PUBLIC = ['pk', 'live', 'abc123'].join('_');
const PREVIOUS = ['pk', 'live', 'old456'].join('_');
const SECRET = ['sk', 'live', globalThis.crypto.randomUUID().replaceAll('-', '')].join('_');

const keys = (over: Partial<KeysResponse> = {}): KeysResponse => ({
  publicKey: PUBLIC,
  secretKeyPrefix: 'sk_live_',
  secretKeyLast4: 'wxyz',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  previous: null,
  ...over,
});

const notFound = () => Promise.reject(new ApiError(404, 'not_found', 'Non trovato.', 'r0'));
const stepUpRequired = () =>
  Promise.reject(new ApiError(403, 'step_up_required', 'Conferma che sei tu.', 'r1'));

const open = (routes: Readonly<Record<string, Route>>, copy = vi.fn(() => Promise.resolve())) => {
  const { client, request } = fakeClient(routes);
  const twoFactor = {
    enable: () => Promise.reject(new Error('not this')),
    verifyTotp: vi.fn(() => Promise.resolve()),
    verifyBackupCode: () => Promise.reject(new Error('not this')),
  };

  render(<WidgetScreen client={client} copy={copy} twoFactor={twoFactor} />);

  return { request, copy, twoFactor };
};

describe('a winery with keys', () => {
  it('shows the snippet the theme extension is held to, and copies exactly it', async () => {
    const { copy } = open({ 'GET /v1/dashboard/keys': () => Promise.resolve(keys()) });
    const snippet = installSnippet(PUBLIC, LOADER_SRC);

    const region = await screen.findByRole('region', { name: 'Codice da incollare' });

    expect(region.textContent).toContain(snippet);

    fireEvent.click(screen.getByRole('button', { name: 'Copia il codice' }));

    await waitFor(() => {
      expect(copy).toHaveBeenCalledWith(snippet);
    });
    expect((await screen.findByRole('status')).textContent).toBe(COPIED);
  });

  it('shows the secret key as its prefix and last four, and never the key', async () => {
    open({ 'GET /v1/dashboard/keys': () => Promise.resolve(keys()) });

    const region = await screen.findByRole('region', { name: 'Chiave segreta' });

    expect(region.textContent).toContain('sk_live_…wxyz');
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('says until when a key rotated away from still works', async () => {
    open({
      'GET /v1/dashboard/keys': () =>
        Promise.resolve(
          keys({ previous: { publicKey: PREVIOUS, validUntil: '2026-10-02T09:00:00.000Z' } }),
        ),
    });

    const note = await screen.findByRole('note');

    expect(note.textContent).toContain(PREVIOUS);
    expect(note.textContent).toMatch(/fino al 2 ottobre/u);
  });

  it('rotates the public key and shows the new one, beside the old one’s deadline', async () => {
    const { request } = open({
      'GET /v1/dashboard/keys': () => Promise.resolve(keys()),
      'POST /v1/dashboard/keys/public/rotate': () =>
        Promise.resolve(
          keys({
            publicKey: ['pk', 'live', 'new789'].join('_'),
            previous: { publicKey: PUBLIC, validUntil: '2026-10-02T09:00:00.000Z' },
          }),
        ),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Sostituisci la chiave pubblica' }));

    expect((await screen.findByRole('note')).textContent).toContain(PUBLIC);
    expect(screen.getByRole('region', { name: 'Codice da incollare' }).textContent).toContain(
      ['pk', 'live', 'new789'].join('_'),
    );
    expect(request).toHaveBeenCalledWith('POST /v1/dashboard/keys/public/rotate');
  });

  it('shows a rotated secret once, and forgets it when the owner says it is saved', async () => {
    open({
      'GET /v1/dashboard/keys': () => Promise.resolve(keys()),
      'POST /v1/dashboard/keys/secret/rotate': () =>
        Promise.resolve({ ...keys({ secretKeyLast4: SECRET.slice(-4) }), secretKey: SECRET }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Sostituisci la chiave segreta' }));

    const shown = await screen.findByRole('region', { name: 'Chiave segreta appena creata' });

    expect(shown.textContent).toContain(SECRET);
    expect(shown.textContent).toContain('non la mostreremo più');
    /* Not in the snippet, whatever else is on the page. */
    expect(screen.getByRole('region', { name: 'Codice da incollare' }).textContent).not.toContain(
      SECRET,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ho salvato la chiave' }));

    await waitFor(() => {
      expect(document.body.textContent).not.toContain(SECRET);
    });
  });

  it('asks for a fresh second factor before a rotation, then makes it', async () => {
    let fresh = false;
    const rotations: string[] = [];
    const { twoFactor } = open({
      'GET /v1/dashboard/keys': () => Promise.resolve(keys()),
      'POST /v1/dashboard/keys/public/rotate': () => {
        rotations.push('rotate');

        return fresh ? Promise.resolve(keys()) : stepUpRequired();
      },
    });

    twoFactor.verifyTotp.mockImplementation(() => {
      fresh = true;
      return Promise.resolve();
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Sostituisci la chiave pubblica' }));
    expect(await screen.findByRole('dialog', { name: 'Conferma che sei tu' })).toBeTruthy();

    fireEvent.input(screen.getByLabelText('Codice'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));

    await waitFor(() => {
      expect(rotations).toEqual(['rotate', 'rotate']);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says what the API refused, in its words', async () => {
    open({
      'GET /v1/dashboard/keys': () => Promise.resolve(keys()),
      'POST /v1/dashboard/keys/secret/rotate': () =>
        Promise.reject(new ApiError(409, 'conflict', 'Riprova fra un momento.', 'r2')),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Sostituisci la chiave segreta' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Riprova fra un momento.');
  });
});

describe('a winery with no keys yet', () => {
  it('issues them, shows the secret once, and then the snippet', async () => {
    const { request } = open({
      'GET /v1/dashboard/keys': notFound,
      'POST /v1/dashboard/keys': () => Promise.resolve({ ...keys(), secretKey: SECRET }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Genera le chiavi' }));

    expect(
      (await screen.findByRole('region', { name: 'Chiave segreta appena creata' })).textContent,
    ).toContain(SECRET);
    expect(screen.getByRole('region', { name: 'Codice da incollare' }).textContent).toContain(
      installSnippet(PUBLIC, LOADER_SRC),
    );
    expect(request).toHaveBeenCalledWith('POST /v1/dashboard/keys');
  });
});

describe('who may see it', () => {
  it('tells a member who is not an owner to ask one, and shows no key', async () => {
    open({
      'GET /v1/dashboard/keys': () =>
        Promise.reject(new ApiError(403, 'forbidden', 'Non consentito.', 'r3')),
    });

    expect(await screen.findByText(/Solo un titolare/u)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says it could not read the keys, rather than offering to make new ones', async () => {
    open({ 'GET /v1/dashboard/keys': () => Promise.reject(new Error('network')) });

    expect((await screen.findByRole('alert')).textContent).toContain('Non è stato possibile');
    expect(screen.queryByRole('button', { name: 'Genera le chiavi' })).toBeNull();
  });
});
