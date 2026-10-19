import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { twoFactorApi, twoFactorMessage, type TwoFactorApi } from '../security/two-factor.js';
import { authApi, authMessage, type AuthApi } from './auth-api.js';

/**
 * Accedi (P0-45b): email and password, then — for an account with a second
 * factor (P4-11) — a code from the app or one backup code.
 *
 * **The shell linked here and nothing was here.** P0-57 sent a signed-out
 * visitor to `/accedi` "because the form is Better Auth's and lives at its own
 * route", and the library has no form: every signed-out visitor met "La
 * sessione è scaduta" and a link back to the same message.
 *
 * Signed in, the page is left for the console with a full load rather than a
 * route change, so the shell reads the session the server just set instead of
 * the signed-out one it already holds.
 */
export const SignInScreen = ({
  api = authApi,
  twoFactor = twoFactorApi,
  onSignedIn = () => {
    globalThis.location.assign('/');
  },
}: {
  readonly api?: AuthApi | undefined;
  readonly twoFactor?: TwoFactorApi | undefined;
  readonly onSignedIn?: (() => void) | undefined;
}): JSX.Element => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const signIn = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);

    try {
      const answer = await api.signIn(email.trim(), password);

      if (answer.twoFactor) {
        setStep('code');
      } else {
        onSignedIn();
      }
    } catch (caught) {
      setError(authMessage(caught));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);

    try {
      if (backup) await twoFactor.verifyBackupCode(code.trim());
      else await twoFactor.verifyTotp(code.trim());

      onSignedIn();
    } catch (caught) {
      setError(twoFactorMessage(caught));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="cr-auth">
      <h1>Accedi a Catalogo Rosso</h1>

      {step === 'password' ? (
        <form
          onSubmit={(event: Event) => {
            event.preventDefault();
            void signIn();
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
          <label>
            Password
            <input
              type="password"
              autocomplete="current-password"
              value={password}
              onInput={(event: Event) => {
                setPassword((event.currentTarget as HTMLInputElement).value);
              }}
              required
            />
          </label>
          <button type="submit" disabled={busy || email.trim() === '' || password === ''}>
            Accedi
          </button>
          <p>
            <a href="/password-dimenticata">Password dimenticata?</a>
          </p>
        </form>
      ) : (
        <form
          onSubmit={(event: Event) => {
            event.preventDefault();
            void verify();
          }}
        >
          <p>
            {backup
              ? 'Inserisci uno dei codici di backup. Ciascuno vale una volta sola.'
              : "Inserisci il codice dall'app di autenticazione."}
          </p>
          <label>
            {backup ? 'Codice di backup' : 'Codice'}
            <input
              autocomplete="one-time-code"
              inputMode={backup ? 'text' : 'numeric'}
              value={code}
              onInput={(event: Event) => {
                setCode((event.currentTarget as HTMLInputElement).value);
              }}
              required
            />
          </label>
          <button type="submit" disabled={busy || code.trim() === ''}>
            Conferma
          </button>
          <button
            type="button"
            onClick={() => {
              setBackup(!backup);
              setCode('');
              setError(undefined);
            }}
          >
            {backup ? "Usa l'app di autenticazione" : 'Usa un codice di backup'}
          </button>
        </form>
      )}

      {error === undefined ? null : <p role="alert">{error}</p>}
    </main>
  );
};
