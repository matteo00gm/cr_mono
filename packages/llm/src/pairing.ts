import {
  leaksInstructions,
  parsePairingOutput,
  type PairingChunk,
  type PairingOutput,
} from '@catalogorosso/core';

/**
 * A model's structured output as a pairing, or `undefined` for anything that
 * cannot be trusted as given (P1-42, shared from P1-43).
 *
 * One function for every adapter, so "checked before it is believed" means the
 * same thing whichever model answered. Unparseable JSON, a schema failure and a
 * leaked instruction all end the same way — no cards. Empty text is the case
 * where the model produced no structured output at all.
 */
export const trustedPairing = (raw: string): PairingOutput | undefined => {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const parsed = parsePairingOutput(json);
  if (!parsed.ok) return undefined;

  const { reply, recommendations } = parsed.value;
  const leaked =
    leaksInstructions(reply) || recommendations.some((item) => leaksInstructions(item.reason));

  return leaked ? undefined : parsed.value;
};

/** What every provider failure looks like to the caller, whichever vendor it came from. */
export const PROVIDER_ERROR: PairingChunk = { type: 'error', code: 'provider_error' };
