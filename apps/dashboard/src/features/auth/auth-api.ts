import { AUTH_BASE_PATH } from '../../session.js';

/**
 * Signing in, and getting back in, from the dashboard's side (P0-45b).
 *
 * **Plain requests to Better Auth's own endpoints**, same-origin with the
 * session cookie, as `two-factor.ts` makes them: a port the screens take as a
 * prop is what lets their tests run with no network. The paths and bodies are
 * the ones `mfa.integration.test.ts` and `auth-security.integration.test.ts`
 * drive against the real server.
 */

/** Why a call failed: the status and the auth library's code. Its message is never shown. */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SignedIn {
  /** The account has a second factor: a code is asked for before there is a session (P4-11). */
  readonly twoFactor: boolean;
}

export interface AuthApi {
  readonly signIn: (email: string, password: string) => Promise<SignedIn>;
  /** Sends a reset link, whether or not the address has an account — the answer is the same. */
  readonly requestReset: (email: string, redirectTo: string) => Promise<void>;
  readonly resetPassword: (token: string, newPassword: string) => Promise<void>;
}

const REQUEST_FAILED = 'La richiesta non è andata a buon fine. Riprova fra un momento.';
const TOO_MANY_ATTEMPTS = 'Troppi tentativi. Riprova tra qualche minuto.';

/** The shortest password the server accepts (Better Auth's default). */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * The codes a seller can do something about, in our words (P6-12). A `Map`,
 * because the code is the server's and `toString` on an object is a function.
 */
const COPY_BY_CODE: ReadonlyMap<string, string> = new Map([
  ['INVALID_EMAIL_OR_PASSWORD', 'Email o password non corretti.'],
  ['INVALID_EMAIL', 'L’indirizzo email non è valido.'],
  ['PASSWORD_TOO_SHORT', `La password deve avere almeno ${String(MIN_PASSWORD_LENGTH)} caratteri.`],
  ['PASSWORD_TOO_LONG', 'La password è troppo lunga.'],
  ['INVALID_TOKEN', 'Il link non è più valido: chiedine uno nuovo.'],
  ['ACCOUNT_TEMPORARILY_LOCKED', TOO_MANY_ATTEMPTS],
]);

/**
 * What a seller reads when an auth call is refused: ours, by code, in Italian.
 * The two-factor step's refusals are `twoFactorMessage`'s, which knows its codes.
 */
export const authMessage = (error: unknown): string => {
  if (!(error instanceof AuthError)) return REQUEST_FAILED;
  if (error.status === 429) return TOO_MANY_ATTEMPTS;

  return (error.code === undefined ? undefined : COPY_BY_CODE.get(error.code)) ?? REQUEST_FAILED;
};

const post = async (path: string, body: unknown): Promise<unknown> => {
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
    throw new AuthError(response.status, payload.code, payload.message ?? REQUEST_FAILED);
  }

  return payload;
};

export const authApi: AuthApi = {
  signIn: async (email, password) => {
    const answer = (await post('/sign-in/email', { email, password })) as {
      twoFactorRedirect?: boolean;
    };

    return { twoFactor: answer.twoFactorRedirect === true };
  },
  requestReset: async (email, redirectTo) => {
    await post('/request-password-reset', { email, redirectTo });
  },
  resetPassword: async (token, newPassword) => {
    await post('/reset-password', { token, newPassword });
  },
};
