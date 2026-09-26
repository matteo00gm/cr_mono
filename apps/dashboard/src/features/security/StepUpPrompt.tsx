import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { TwoFactorError, twoFactorApi, type TwoFactorApi } from './two-factor.js';

/**
 * Confirming it is you, before a sensitive action (P4-11).
 *
 * Shown when the API answers `step_up_required`: the owner's last second
 * factor is more than fifteen minutes old, and the action — a key, a domain
 * removal, a membership change — is one a stolen session must not be able to
 * take. A code from the app, or one backup code, and the caller retries the
 * action it was doing; nothing here knows what that was.
 *
 * `onVerified` runs only after the server accepted the code, so a retry is
 * never made on a verification that did not happen.
 */
export const StepUpPrompt = ({
  onVerified,
  onCancel,
  api = twoFactorApi,
}: {
  readonly onVerified: () => void;
  readonly onCancel: () => void;
  readonly api?: TwoFactorApi | undefined;
}): JSX.Element => {
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);

    try {
      if (backup) await api.verifyBackupCode(code.trim());
      else await api.verifyTotp(code.trim());

      onVerified();
    } catch (caught) {
      setError(
        caught instanceof TwoFactorError && caught.status === 429
          ? 'Troppi tentativi. Riprova tra qualche minuto.'
          : 'Codice non valido.',
      );
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="step-up" role="dialog" aria-modal="true" aria-labelledby="step-up-title">
      <h2 id="step-up-title">Conferma che sei tu</h2>
      <p>
        {backup
          ? 'Inserisci uno dei codici di backup. Ciascuno vale una volta sola.'
          : "Inserisci il codice dall'app di autenticazione per continuare."}
      </p>
      <form
        onSubmit={(event: Event) => {
          event.preventDefault();
          void submit();
        }}
      >
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
        <button type="button" onClick={onCancel}>
          Annulla
        </button>
      </form>
      <button
        type="button"
        class="step-up-switch"
        onClick={() => {
          setBackup(!backup);
          setCode('');
          setError(undefined);
        }}
      >
        {backup ? "Usa l'app di autenticazione" : 'Usa un codice di backup'}
      </button>
      {error === undefined ? null : <p role="alert">{error}</p>}
    </div>
  );
};
