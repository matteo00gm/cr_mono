import type { ApiClient } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/app.js';
import { AuthError, authApi, authMessage, type AuthApi } from '../src/features/auth/auth-api.js';
import {
  ForgotPasswordScreen,
  RESET_PATH,
  RESET_SENT,
  ResetPasswordScreen,
  resetTokenOf,
} from '../src/features/auth/PasswordScreens.js';
import { SignInScreen } from '../src/features/auth/SignInScreen.js';
import { TwoFactorError, type TwoFactorApi } from '../src/features/security/two-factor.js';
import { AUTH_BASE_PATH } from '../src/session.js';

/**
 * Signing in and getting back in (P0-45b): the pages the shell sent a
 * signed-out visitor to, which did not exist.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.history.pushState({}, '', '/');
});

const auth = (over: Partial<AuthApi> = {}): AuthApi => ({
  signIn: vi.fn(() => Promise.resolve({ twoFactor: false })),
  requestReset: vi.fn(() => Promise.resolve()),
  resetPassword: vi.fn(() => Promise.resolve()),
  ...over,
});

const factor = (over: Partial<TwoFactorApi> = {}): TwoFactorApi => ({
  enable: () => Promise.reject(new Error('not this')),
  verifyTotp: vi.fn(() => Promise.resolve()),
  verifyBackupCode: vi.fn(() => Promise.resolve()),
  ...over,
});

const type = (label: string, value: string) => {
  fireEvent.input(screen.getByLabelText(label), { target: { value } });
};

const signInAs = (email = 'giulia@cantina.example', password = 'una-password-lunga') => {
  type('Email', email);
  type('Password', password);
  fireEvent.click(screen.getByRole('button', { name: 'Accedi' }));
};

describe('signing in', () => {
  it('enters the console at once for an account with no second factor', async () => {
    const api = auth();
    const onSignedIn = vi.fn();

    render(<SignInScreen api={api} twoFactor={factor()} onSignedIn={onSignedIn} />);
    signInAs(' giulia@cantina.example ');

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    });
    expect(api.signIn).toHaveBeenCalledWith('giulia@cantina.example', 'una-password-lunga');
  });

  it('asks for the code before the console when the account has a second factor (P4-11)', async () => {
    const twoFactor = factor();
    const onSignedIn = vi.fn();

    render(
      <SignInScreen
        api={auth({ signIn: () => Promise.resolve({ twoFactor: true }) })}
        twoFactor={twoFactor}
        onSignedIn={onSignedIn}
      />,
    );
    signInAs();

    await screen.findByLabelText('Codice');
    type('Codice', ' 123456 ');
    expect(onSignedIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    });
    expect(twoFactor.verifyTotp).toHaveBeenCalledWith('123456');
  });

  it('takes a backup code instead, when asked to', async () => {
    const twoFactor = factor();

    render(
      <SignInScreen
        api={auth({ signIn: () => Promise.resolve({ twoFactor: true }) })}
        twoFactor={twoFactor}
        onSignedIn={vi.fn()}
      />,
    );
    signInAs();
    fireEvent.click(await screen.findByRole('button', { name: 'Usa un codice di backup' }));
    type('Codice di backup', 'abcd-efgh');
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));

    await waitFor(() => {
      expect(twoFactor.verifyBackupCode).toHaveBeenCalledWith('abcd-efgh');
    });
    expect(twoFactor.verifyTotp).not.toHaveBeenCalled();
  });

  it('says a wrong password in our words, and clears it', async () => {
    const onSignedIn = vi.fn();

    render(
      <SignInScreen
        api={auth({
          signIn: () =>
            Promise.reject(new AuthError(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email')),
        })}
        twoFactor={factor()}
        onSignedIn={onSignedIn}
      />,
    );
    signInAs();

    expect((await screen.findByRole('alert')).textContent).toBe('Email o password non corretti.');
    expect(screen.getByLabelText('Password')).toHaveProperty('value', '');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('says a refused code in our words, and stays on the code', async () => {
    const onSignedIn = vi.fn();

    render(
      <SignInScreen
        api={auth({ signIn: () => Promise.resolve({ twoFactor: true }) })}
        twoFactor={factor({
          verifyTotp: () => Promise.reject(new TwoFactorError(401, 'INVALID_CODE', 'Invalid')),
        })}
        onSignedIn={onSignedIn}
      />,
    );
    signInAs();
    await screen.findByLabelText('Codice');
    type('Codice', '000000');
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Codice non valido.');
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});

describe('the auth library’s refusals', () => {
  it('reads as ours, by code, and as a generic line for anything else', () => {
    expect(authMessage(new AuthError(429, undefined, 'Too many'))).toMatch(/Troppi tentativi/u);
    expect(authMessage(new AuthError(400, 'INVALID_TOKEN', 'x'))).toMatch(/non è più valido/u);
    expect(authMessage(new AuthError(400, 'PASSWORD_TOO_SHORT', 'x'))).toMatch(/almeno 8/u);
    expect(authMessage(new AuthError(400, 'toString', 'x'))).toMatch(/non è andata a buon fine/u);
    expect(authMessage(new Error('network'))).toMatch(/non è andata a buon fine/u);
  });
});

describe('the requests', () => {
  const stub = (status: number, body: unknown) => {
    const fetch_ = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    );

    vi.stubGlobal('fetch', fetch_);

    return fetch_;
  };

  const sent = (fetch_: ReturnType<typeof stub>) => {
    const [url, init] = fetch_.mock.calls[0] ?? [];

    return {
      url: typeof url === 'string' ? url : '',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      credentials: init?.credentials,
    };
  };

  it('signs in at the library’s path, and reads the second-factor answer', async () => {
    const fetch_ = stub(200, { twoFactorRedirect: true });

    expect(await authApi.signIn('a@b.example', 'pw-pw-pw-pw')).toEqual({ twoFactor: true });
    expect(sent(fetch_)).toEqual({
      url: `${AUTH_BASE_PATH}/sign-in/email`,
      body: { email: 'a@b.example', password: 'pw-pw-pw-pw' },
      credentials: 'same-origin',
    });
  });

  it('asks for a reset link, and resets with the token', async () => {
    let fetch_ = stub(200, { status: true });

    await authApi.requestReset('a@b.example', `https://app.example${RESET_PATH}`);
    expect(sent(fetch_)).toMatchObject({
      url: `${AUTH_BASE_PATH}/request-password-reset`,
      body: { email: 'a@b.example', redirectTo: `https://app.example${RESET_PATH}` },
    });

    fetch_ = stub(200, { status: true });
    await authApi.resetPassword('the-token', 'nuova-password');
    expect(sent(fetch_)).toMatchObject({
      url: `${AUTH_BASE_PATH}/reset-password`,
      body: { token: 'the-token', newPassword: 'nuova-password' },
    });
  });

  it('carries the status and the code of a refusal', async () => {
    stub(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });

    await expect(authApi.signIn('a@b.example', 'x')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_EMAIL_OR_PASSWORD',
    });
  });
});

describe('a forgotten password', () => {
  it('asks for a link that comes back to the reset page, and says the same whatever happened', async () => {
    const api = auth();

    render(<ForgotPasswordScreen api={api} origin="https://app.example" />);
    type('Email', 'giulia@cantina.example');
    fireEvent.click(screen.getByRole('button', { name: 'Inviami il link' }));

    expect((await screen.findByRole('status')).textContent).toBe(RESET_SENT);
    expect(api.requestReset).toHaveBeenCalledWith(
      'giulia@cantina.example',
      `https://app.example${RESET_PATH}`,
    );
  });

  it('says it was sent even when the server refused, so no address is told apart', async () => {
    render(
      <ForgotPasswordScreen
        api={auth({ requestReset: () => Promise.reject(new AuthError(400, 'X', 'x')) })}
        origin="https://app.example"
      />,
    );
    type('Email', 'nobody@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Inviami il link' }));

    expect((await screen.findByRole('status')).textContent).toBe(RESET_SENT);
  });

  it('says so when there have been too many requests', async () => {
    render(
      <ForgotPasswordScreen
        api={auth({ requestReset: () => Promise.reject(new AuthError(429, undefined, 'x')) })}
        origin="https://app.example"
      />,
    );
    type('Email', 'giulia@cantina.example');
    fireEvent.click(screen.getByRole('button', { name: 'Inviami il link' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Troppi tentativi/u);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('a reset link', () => {
  it('carries its token, or says why it does not', () => {
    expect(resetTokenOf('?token=abc')).toEqual({ token: 'abc' });
    expect(resetTokenOf('?error=INVALID_TOKEN')).toEqual({ refused: true });
    expect(resetTokenOf('?token=abc&error=INVALID_TOKEN')).toEqual({ refused: true });
    expect(resetTokenOf('')).toEqual({ refused: true });
    expect(resetTokenOf('?token=')).toEqual({ refused: true });
  });

  it('offers a new link when this one was refused', () => {
    render(<ResetPasswordScreen api={auth()} search="?error=INVALID_TOKEN" />);

    expect(screen.getByRole('alert').textContent).toMatch(/non è più valido/u);
    expect(screen.queryByLabelText('Nuova password')).toBeNull();
  });

  it('refuses two passwords that differ, or one that is short, before asking anybody', async () => {
    const api = auth();

    render(<ResetPasswordScreen api={api} search="?token=abc" />);
    type('Nuova password', 'corta');
    type('Ripeti la nuova password', 'corta');
    fireEvent.click(screen.getByRole('button', { name: 'Salva la nuova password' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/almeno 8/u);

    type('Nuova password', 'una-password-lunga');
    type('Ripeti la nuova password', 'un-altra-password');
    fireEvent.click(screen.getByRole('button', { name: 'Salva la nuova password' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Le due password non coincidono.');
    expect(api.resetPassword).not.toHaveBeenCalled();
  });

  it('resets with the token, and says every old session was closed', async () => {
    const api = auth();

    render(<ResetPasswordScreen api={api} search="?token=abc" />);
    type('Nuova password', 'una-password-lunga');
    type('Ripeti la nuova password', 'una-password-lunga');
    fireEvent.click(screen.getByRole('button', { name: 'Salva la nuova password' }));

    expect((await screen.findByRole('status')).textContent).toMatch(/ogni sessione/u);
    expect(api.resetPassword).toHaveBeenCalledWith('abc', 'una-password-lunga');
    expect(screen.getByRole('link', { name: 'Accedi' })).toHaveProperty(
      'href',
      expect.stringContaining('/accedi'),
    );
  });

  it('says a spent token in our words', async () => {
    render(
      <ResetPasswordScreen
        api={auth({
          resetPassword: () => Promise.reject(new AuthError(400, 'INVALID_TOKEN', 'Invalid token')),
        })}
        search="?token=abc"
      />,
    );
    type('Nuova password', 'una-password-lunga');
    type('Ripeti la nuova password', 'una-password-lunga');
    fireEvent.click(screen.getByRole('button', { name: 'Salva la nuova password' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/non è più valido/u);
  });
});

describe('the console’s front door', () => {
  const signedOut = {
    request: () => Promise.reject(new Error('unauthenticated')),
  } as unknown as ApiClient;

  it('serves the sign-in page to a signed-out visitor, rather than a link to itself', () => {
    globalThis.history.pushState({}, '', '/accedi');
    render(<App client={signedOut} />);

    expect(screen.getByRole('heading', { name: 'Accedi a Catalogo Rosso' })).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('serves the password pages without a session too', () => {
    globalThis.history.pushState({}, '', '/password-dimenticata');
    render(<App client={signedOut} />);

    expect(screen.getByRole('heading', { name: 'Password dimenticata' })).toBeTruthy();
  });

  it('keeps everything else behind the gate', async () => {
    globalThis.history.pushState({}, '', '/catalogo');
    render(<App client={signedOut} />);

    expect(await screen.findByRole('link', { name: 'Accedi' })).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });
});
