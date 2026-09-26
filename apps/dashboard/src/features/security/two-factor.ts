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

/** Why a call failed, in words the screen can show, or a generic line when there are none. */
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
    throw new TwoFactorError(
      response.status,
      payload.code,
      payload.message ?? 'La richiesta non è andata a buon fine.',
    );
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
