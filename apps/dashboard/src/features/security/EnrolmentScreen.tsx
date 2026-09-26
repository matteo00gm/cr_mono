import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import {
  setupKeyOf,
  TwoFactorError,
  twoFactorApi,
  type Enrolment,
  type TwoFactorApi,
} from './two-factor.js';

/**
 * Turning on two-factor authentication (P4-11).
 *
 * **The screen an owner is sent to instead of an opaque 403.** Three steps,
 * each one the server insists on: the password, because enrolling changes how
 * the account is protected; the authenticator, with its backup codes shown once
 * and never again; and a code from the app, because a secret nobody has proved
 * is a way to lock yourself out.
 *
 * No QR image yet. The `otpauth://` link opens an authenticator on the same
 * phone, and the setup key covers every other case; drawing a QR code means a
 * dependency, which is the dashboard polish row's to add.
 *
 * Text nodes only, like everything else here — the setup key and the codes are
 * values from the server, and none of them is ever markup.
 */

type Step =
  | { readonly kind: 'password' }
  | { readonly kind: 'authenticator'; readonly enrolment: Enrolment }
  | { readonly kind: 'done' };

const messageOf = (error: unknown): string =>
  error instanceof TwoFactorError ? error.message : 'La richiesta non è andata a buon fine.';

export const EnrolmentScreen = ({
  enrolled,
  api = twoFactorApi,
}: {
  /** Already on, from `/me`: there is nothing to enrol. */
  readonly enrolled: boolean;
  readonly api?: TwoFactorApi | undefined;
}): JSX.Element => {
  const [step, setStep] = useState<Step>({ kind: enrolled ? 'done' : 'password' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const attempt = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);

    try {
      await run();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  if (step.kind === 'done') {
    return (
      <section class="security">
        <h1>Sicurezza</h1>
        <p role="status">La verifica in due passaggi è attiva.</p>
      </section>
    );
  }

  if (step.kind === 'password') {
    return (
      <section class="security">
        <h1>Attiva la verifica in due passaggi</h1>
        <p>
          Chi gestisce chiavi, domini, membri e fatturazione deve confermare l&apos;accesso con un
          codice dall&apos;app di autenticazione. Il catalogo resta disponibile nel frattempo.
        </p>
        <form
          onSubmit={(event: Event) => {
            event.preventDefault();
            void attempt(async () => {
              setStep({ kind: 'authenticator', enrolment: await api.enable(password) });
              setPassword('');
            });
          }}
        >
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
          <button type="submit" disabled={busy || password === ''}>
            Continua
          </button>
        </form>
        {error === undefined ? null : <p role="alert">{error}</p>}
      </section>
    );
  }

  const { enrolment } = step;
  const setupKey = setupKeyOf(enrolment.totpURI);

  return (
    <section class="security">
      <h1>Collega l&apos;app di autenticazione</h1>
      {/* Only ever an authenticator link: a value from a server never becomes `javascript:`. */}
      {enrolment.totpURI.startsWith('otpauth://') ? (
        <p>
          <a href={enrolment.totpURI}>Apri nell&apos;app di autenticazione</a>
        </p>
      ) : null}
      {setupKey === undefined ? null : (
        <p>
          Oppure inserisci questa chiave: <code class="security-key">{setupKey}</code>
        </p>
      )}

      <h2>Codici di backup</h2>
      <p>
        Conservali ora in un posto sicuro: ciascuno vale una volta sola e non li mostreremo di
        nuovo.
      </p>
      <ul class="security-codes" aria-label="Codici di backup">
        {enrolment.backupCodes.map((backup) => (
          <li key={backup}>
            <code>{backup}</code>
          </li>
        ))}
      </ul>

      <form
        onSubmit={(event: Event) => {
          event.preventDefault();
          void attempt(async () => {
            await api.verifyTotp(code.trim());
            setStep({ kind: 'done' });
          });
        }}
      >
        <label>
          Codice dall&apos;app
          <input
            inputMode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onInput={(event: Event) => {
              setCode((event.currentTarget as HTMLInputElement).value);
            }}
            required
          />
        </label>
        <button type="submit" disabled={busy || code.trim().length !== 6}>
          Attiva
        </button>
      </form>
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
};
