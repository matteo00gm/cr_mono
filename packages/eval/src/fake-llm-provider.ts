import type { LlmProvider, PairingChunk, PairingRequest } from '@catalogorosso/core';

/**
 * A generation provider that answers from a script (P1-41, landed with P1-46).
 *
 * For the chat route's tests (P2-29) and the eval harness's deterministic run
 * (P1-46): both need a provider that streams, honours its abort signal and can
 * be told to fail in each of the three ways a real one does, with no network
 * and no bill.
 *
 * **It stops the moment the signal aborts**, between chunks, the way a real
 * stream should — so a test asserting that a visitor who leaves stops the
 * generation fails against this fake if the caller never aborts, rather than
 * passing because the fake did not care.
 */

export interface FakeLlmProvider extends LlmProvider {
  /** Every request received, in order. */
  readonly requests: readonly PairingRequest[];
  /** Every chunk actually handed to a consumer, across all calls. Stops growing on abort. */
  readonly emitted: readonly PairingChunk[];
}

export interface FakeLlmOptions {
  readonly id?: string | undefined;
  /** What to stream for a request. By default, a short reply recommending the first candidate. */
  readonly respond?: ((request: PairingRequest) => readonly PairingChunk[]) | undefined;
}

/** The first candidate, or an honest "nothing fits" when there are none. */
const firstCandidate = (request: PairingRequest): readonly PairingChunk[] => {
  const first = request.candidates[0];

  if (first === undefined) {
    return [{ type: 'text', delta: 'Non ho trovato vini adatti in questo catalogo.' }];
  }

  return [
    { type: 'text', delta: `Per «${request.query}» consiglio ` },
    { type: 'text', delta: `${first.name ?? 'questo vino'}.` },
    {
      type: 'recommendations',
      items: [
        {
          productId: first.id,
          reason: 'Il più vicino alla richiesta tra i vini disponibili.',
          confidence: 0.5,
        },
      ],
    },
  ];
};

export const fakeLlmProvider = (options: FakeLlmOptions = {}): FakeLlmProvider => {
  const requests: PairingRequest[] = [];
  const emitted: PairingChunk[] = [];
  const respond = options.respond ?? firstCandidate;

  return {
    id: options.id ?? 'fake',
    requests,
    emitted,

    streamPairing(request, signal) {
      requests.push(request);
      const chunks = respond(request);

      return (async function* () {
        for (const chunk of chunks) {
          // A real stream yields to the event loop between chunks, which is
          // when a caller gets the chance to abort.
          await Promise.resolve();
          if (signal.aborted) return;

          emitted.push(chunk);
          yield chunk;
        }
      })();
    },
  };
};
