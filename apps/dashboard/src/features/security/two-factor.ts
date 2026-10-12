import { ApiError } from '@catalogorosso/api-client';

import { AUTH_BASE_PATH } from '../../session.js';

/**
 * Two-factor authentication, from the dashboard's side (P4-11).
 *
 * **Plain requests to Better Auth's own endpoints**, same-origin with the
 * session cookie, rather than its client plugin: three calls do not need a
 * second client, and a port the screens take as a prop is what lets their tests
 * run with no network. What the server does with each call — hashing, replay,
 * the budget, the step-up — is `packages/core/src/auth-mfa.ts`'s.
 */

export interface Enrolment {
  /** `otpauth://` — what an authenticator app is given. */
  readonly totpURI: string;
  /** Shown once, now, and never retrievable again: the server keeps only hashes. */
  readonly backupCodes: readonly string[];
}

export interface TwoFactorApi {
  readonly enable: (password: string) => Promise<Enrolment>;
  readonly verifyTotp: (code: string) => Promise<void>;
  readonly verifyBackupCode: (code: string) => Promise<void>;
}

/**
 * Why a call failed: the status and the auth library's code.
 *
 * **Its `message` is never shown** (P6-12). These endpoints are the auth
 * library's, and so are their sentences — English, and not ours to write at
 * the source the way every other refusal on this surface is. So this is the
 * one place the dashboard maps a code to its own copy: `twoFactorMessage`.
 */
export class TwoFactorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'TwoFactorError';
  }
}

const REQUEST_FAILED = 'La richiesta non è andata a buon fine.';
const TOO_MANY_ATTEMPTS = 'Troppi tentativi. Riprova tra qualche minuto.';
const CODE_REFUSED = 'Codice non valido.';

/**
 * The codes a seller can do something about. Anything else gets the generic line.
 *
 * A `Map`, not an object: the code is the server's, and `toString` looked up
 * on an object is a function rather than nothing.
 */
const COPY_BY_CODE: ReadonlyMap<string, string> = new Map([
  ['INVALID_PASSWORD', 'La password non è corretta.'],
  ['INVALID_CODE', CODE_REFUSED],
  ['INVALID_BACKUP_CODE', CODE_REFUSED],
  ['ACCOUNT_TEMPORARILY_LOCKED', TOO_MANY_ATTEMPTS],
  ['SESSION_EXPIRED', 'La sessione è scaduta. Accedi di nuovo.'],
  [
    'STEP_UP_REQUIRED',
    'Inserisci un codice dalla tua app di autenticazione per modificare la verifica in due passaggi.',
  ],
]);

/** What a seller reads when a two-factor call is refused: ours, by code, in Italian. */
export const twoFactorMessage = (error: unknown): string => {
  if (!(error instanceof TwoFactorError)) return REQUEST_FAILED;
  if (error.status === 429) return TOO_MANY_ATTEMPTS;

  return (error.code === undefined ? undefined : COPY_BY_CODE.get(error.code)) ?? REQUEST_FAILED;
};

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(`${AUTH_BASE_PATH}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
  };

  if (!response.ok) {
    throw new TwoFactorError(response.status, payload.code, payload.message ?? REQUEST_FAILED);
  }

  return payload as T;
};

export const twoFactorApi: TwoFactorApi = {
  enable: (password) => post<Enrolment>('/two-factor/enable', { password }),
  verifyTotp: async (code) => {
    await post('/two-factor/verify-totp', { code });
  },
  verifyBackupCode: async (code) => {
    await post('/two-factor/verify-backup-code', { code });
  },
};

/**
 * The key to type in by hand, for a phone that cannot follow the link.
 *
 * Read out of the `otpauth://` URI rather than asked for separately: the URI
 * is the one thing the server returns, so the two can never disagree.
 */
export const setupKeyOf = (totpURI: string): string | undefined => {
  try {
    const secret = new URL(totpURI).searchParams.get('secret');
    return secret === null || secret === '' ? undefined : secret.replace(/(.{4})(?=.)/gu, '$1 ');
  } catch {
    return undefined;
  }
};

/** The API asked for a fresh code before it would do what was asked. */
export const needsStepUp = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'step_up_required';

/** The API wants the caller to turn on two-factor authentication first. */
export const needsEnrolment = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'mfa_required';
