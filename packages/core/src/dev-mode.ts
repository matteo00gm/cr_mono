import { normalizeOrigin } from '@catalogorosso/security';

/**
 * Development mode (P4-19b): the widget served to one local origin, for a
 * fixed time, so a seller's developer can work on it before it is live.
 *
 * **Twenty-four hours, and the time is the safety.** A permanent localhost
 * allowance would let anyone with a scraped `pk_` drive the API from their own
 * machine for ever. A day is a working session; the next one asks again, and
 * nothing is left open because somebody forgot to close it.
 */
export const DEV_MODE_HOURS = 24;

export const DEV_MODE_LOCAL_ONLY =
  'La modalità sviluppo è per un indirizzo locale, come http://localhost:3000. Un sito di prova ' +
  'va invece aggiunto come dominio di prova.';

/**
 * The normalised origin, if the input is a local one — `localhost` or a name
 * under `.localhost` — and nothing otherwise.
 *
 * **One authority on what an origin is** (P2-05), asked in its development
 * mode, which is the only mode that admits `http:` and `localhost` at all; the
 * answer is then kept only if it really is local. So the dashboard and the
 * widget's CORS check agree exactly on which strings can ever be a development
 * origin, and a public origin can never become one.
 */
export const localOrigin = (input: string): string | undefined => {
  const normalised = normalizeOrigin(input, { environment: 'development' });

  if (!normalised.ok) return undefined;

  const host = new URL(normalised.origin).hostname;

  return host === 'localhost' || host.endsWith('.localhost') ? normalised.origin : undefined;
};
