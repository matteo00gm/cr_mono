import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { authApi, AuthError, authMessage, MIN_PASSWORD_LENGTH, type AuthApi } from './auth-api.js';

/**
 * Getting back in (P0-45b): asking for a reset link, and choosing a new
 * password from it.
 *
 * The server already did its half — a reset link by email (P0-64), a token
 * spent once, every session ended by the reset (R4) — and nothing in the
 * console asked for one or received one.
 */

/** Where the reset link lands: Better Auth checks the token and sends the browser here with it. */
export const RESET_PATH = '/reimposta-password';

/**
 * The same sentence whether or not the address has an account. Saying "no such
 * account" would tell anybody which addresses are customers (P0-46).
 */
export const RESET_SENT =
  'Se l’indirizzo appartiene a un account, ti abbiamo inviato un link per reimpostare la password. Controlla anche lo spam.';

export const ForgotPasswordScreen = ({
  api = authApi,
  origin = globalThis.location.origin,
}: {
  readonly api?: AuthApi | undefined;
  readonly origin?: string | undefined;
}): JSX.Element => {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);

    try {
      await api.requestReset(email.trim(), `${origin}${RESET_PATH}`);
      setSent(true);
    } catch (caught) {
      /* Too many is worth saying; anything else is the same as sent, for the reason above. */
      if (caught instanceof AuthError && caught.status === 429) setError(authMessage(caught));
      else setSent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="cr-auth">
      <h1>Password dimenticata</h1>
      {sent ? (
        <p role="status">{RESET_SENT}</p>
      ) : (
        <form
          onSubmit={(event: Event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label>
            Email
            <input
              type="email"
              autocomplete="email"
              value={email}
              onInput={(event: Event) => {
                setEmail((event.currentTarget as HTMLInputElement).value);
              }}
              required
            />
          </label>
          <button type="submit" disabled={busy || email.trim() === ''}>
            Inviami il link
          </button>
        </form>
      )}
      {error === undefined ? null : <p role="alert">{error}</p>}
      <p>
        <a href="/accedi">Torna all’accesso</a>
      </p>
    </main>
  );
};

/** The token Better Auth put on the link, or why there is none. */
export const resetTokenOf = (search: string): { token: string } | { refused: true } => {
  const params = new URLSearchParams(search);
  const token = params.get('token');

  return params.has('error') || token === null || token === '' ? { refused: true } : { token };
};

export const ResetPasswordScreen = ({
  api = authApi,
  search = globalThis.location.search,
}: {
  readonly api?: AuthApi | undefined;
  readonly search?: string | undefined;
}): JSX.Element => {
  const link = resetTokenOf(search);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  if ('refused' in link) {
    return (
      <main class="cr-auth">
        <h1>Reimposta la password</h1>
        <p role="alert">Il link non è più valido: chiedine uno nuovo.</p>
        <p>
          <a href="/password-dimenticata">Chiedi un nuovo link</a>
        </p>
      </main>
    );
  }

  const reset = async (): Promise<void> => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`La password deve avere almeno ${String(MIN_PASSWORD_LENGTH)} caratteri.`);
      return;
    }

    if (password !== again) {
      setError('Le due password non coincidono.');
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      await api.resetPassword(link.token, password);
      setDone(true);
    } catch (caught) {
      setError(authMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="cr-auth">
      <h1>Reimposta la password</h1>
      {done ? (
        <>
          <p role="status">
            Fatto: la password è cambiata e ogni sessione aperta con quella vecchia è stata chiusa.
          </p>
          <p>
            <a href="/accedi">Accedi</a>
          </p>
        </>
      ) : (
        <form
          onSubmit={(event: Event) => {
            event.preventDefault();
            void reset();
          }}
        >
          <label>
            Nuova password
            <input
              type="password"
              autocomplete="new-password"
              value={password}
              onInput={(event: Event) => {
                setPassword((event.currentTarget as HTMLInputElement).value);
              }}
              required
            />
          </label>
          <label>
            Ripeti la nuova password
            <input
              type="password"
              autocomplete="new-password"
              value={again}
              onInput={(event: Event) => {
                setAgain((event.currentTarget as HTMLInputElement).value);
              }}
              required
            />
          </label>
          <button type="submit" disabled={busy || password === '' || again === ''}>
            Salva la nuova password
          </button>
        </form>
      )}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </main>
  );
};
