import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type {
  LlmProvider,
  PairingChunk,
  PairingRequest,
  Recommendation,
} from '../../src/rag/llm-provider.js';
import { MAX_REPLY_CHARACTERS } from '../../src/rag/pairing-schema.js';
import { buildPairingPrompt, pairingSystemPrompt } from '../../src/rag/prompt.js';
import { withSchemaRepair, type PairingOutcome } from '../../src/rag/repair.js';

/**
 * One repair attempt, and then an honest answer (P2-27).
 *
 * The two cases that decide whether this is worth having: a first attempt that
 * fails and a second that answers, and a second that fails too. The first is
 * the rate §4.5 says small models miss the schema at; the second is what a
 * visitor sees when a model simply cannot comply, and it has to be a readable
 * answer with no cards rather than an error over prose that was perfectly fine.
 *
 * The bound is the other half. A retry that can retry is a retry that can
 * retry forever, and the visitor is waiting the whole time.
 */

const ASKED: PairingRequest = {
  query: 'qualcosa per una bistecca',
  locale: 'it',
  candidates: [],
  history: [],
};

const card = (): Recommendation => ({
  productId: randomUUID(),
  reason: 'Tannino per il grasso.',
  confidence: 0.9,
});

/** A provider that answers with a different script on each attempt. */
const scripted = (...attempts: readonly (readonly PairingChunk[])[]) => {
  const requests: PairingRequest[] = [];
  let attempt = 0;

  const provider: LlmProvider = {
    id: 'scripted',
    streamPairing: (request) => {
      requests.push(request);
      const script = attempts[attempt] ?? [];

      attempt += 1;

      return (async function* () {
        for (const chunk of script) yield await Promise.resolve(chunk);
      })();
    },
  };

  return { provider, requests, attempts: () => attempt };
};

const run = async (
  provider: LlmProvider,
  onOutcome?: (outcome: PairingOutcome) => void,
): Promise<PairingChunk[]> => {
  const seen: PairingChunk[] = [];
  const options = onOutcome === undefined ? {} : { onOutcome };

  for await (const chunk of withSchemaRepair(
    provider,
    ASKED,
    new AbortController().signal,
    options,
  )) {
    seen.push(chunk);
  }

  return seen;
};

const text = (chunks: readonly PairingChunk[]): string =>
  chunks.map((chunk) => (chunk.type === 'text' ? chunk.delta : '')).join('');

const cards = (chunks: readonly PairingChunk[]): readonly Recommendation[] =>
  chunks.flatMap((chunk) => (chunk.type === 'recommendations' ? [...chunk.items] : []));

describe('when the first attempt answers', () => {
  it('passes it through and asks nothing more', async () => {
    const item = card();
    const { provider, attempts } = scripted([
      { type: 'text', delta: 'Un Barolo.' },
      { type: 'recommendations', items: [item] },
    ]);
    const onOutcome = vi.fn();

    const chunks = await run(provider, onOutcome);

    expect(text(chunks)).toBe('Un Barolo.');
    expect(cards(chunks)).toEqual([item]);
    expect(attempts()).toBe(1);
    expect(onOutcome).toHaveBeenCalledWith('ok');
  });
});

describe('that it is a stream at all', () => {
  it('passes a chunk on before the next one exists', async () => {
    /*
     * **The case that had no test, and the defect it let through.** The first
     * version collected each attempt and yielded it when the attempt ended: a
     * buffered stream and a streamed one produce the same chunks in the same
     * order, so every other case here passed either way. The difference is
     * *when* — and when is the whole feature. Time-to-first-token became
     * total-generation-time, and a reply already written was lost if the
     * provider then failed.
     *
     * This provider will not produce its second chunk until its first has been
     * read, so a consumer that waits for the end waits forever.
     */
    let released: () => void = () => {
      /* Replaced below, before anything can call it. */
    };
    const secondChunk = new Promise<void>((resolve) => {
      released = resolve;
    });

    const provider: LlmProvider = {
      id: 'held',
      streamPairing: () =>
        (async function* () {
          yield await Promise.resolve<PairingChunk>({ type: 'text', delta: 'first' });
          await secondChunk;
          yield { type: 'text', delta: 'second' } satisfies PairingChunk;
        })(),
    };

    const seen: PairingChunk[] = [];

    for await (const chunk of withSchemaRepair(provider, ASKED, new AbortController().signal)) {
      seen.push(chunk);
      released();
    }

    expect(text(seen)).toBe('firstsecond');
  });

  it('keeps what was already written when the provider then fails', async () => {
    // A visitor who read half an answer has read it. Losing it on the throw is
    // what buffering does, and it is invisible in the chunk list either way.
    const provider: LlmProvider = {
      id: 'failing',
      streamPairing: () =>
        (async function* () {
          yield await Promise.resolve<PairingChunk>({ type: 'text', delta: 'Un Barolo' });
          throw new Error('the provider fell over');
        })(),
    };

    const seen: PairingChunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of withSchemaRepair(provider, ASKED, new AbortController().signal)) {
          seen.push(chunk);
        }
      })(),
    ).rejects.toThrow('fell over');

    expect(text(seen)).toBe('Un Barolo');
  });
});

describe('when the first attempt misses the schema', () => {
  it('repairs once and returns the cards', async () => {
    const item = card();
    const { provider, attempts } = scripted(
      [{ type: 'error', code: 'schema_invalid' }],
      [{ type: 'recommendations', items: [item] }],
    );
    const onOutcome = vi.fn();

    const chunks = await run(provider, onOutcome);

    expect(cards(chunks)).toEqual([item]);
    expect(attempts()).toBe(2);
    expect(onOutcome).toHaveBeenCalledWith('repaired');
  });

  it('never sends the schema failure to the visitor', async () => {
    // It is an internal outcome with a next step, not something to render. A
    // widget showing an error for an answer that then arrives is worse than no
    // widget at all.
    const { provider } = scripted(
      [{ type: 'error', code: 'schema_invalid' }],
      [{ type: 'recommendations', items: [card()] }],
    );

    expect(await run(provider)).not.toContainEqual({ type: 'error', code: 'schema_invalid' });
  });

  it('asks the repair as a repair, in the system position', async () => {
    const { provider, requests } = scripted(
      [{ type: 'error', code: 'schema_invalid' }],
      [{ type: 'recommendations', items: [card()] }],
    );

    await run(provider);

    expect(requests[0]?.repairing).toBeUndefined();
    expect(requests[1]?.repairing).toBe(true);

    /*
     * §3.7: an operator instruction goes in the system position and nowhere
     * else. A repair note appended to a turn would sit exactly where retrieved
     * text sits — and would be a model's own failure teaching it that
     * instructions can arrive from there.
     */
    const repaired = buildPairingPrompt({ ...ASKED, repairing: true });

    expect(repaired.system.startsWith(pairingSystemPrompt())).toBe(true);
    expect(repaired.system.length).toBeGreaterThan(pairingSystemPrompt().length);
    expect(repaired.user).toBe(buildPairingPrompt(ASKED).user);
    expect(repaired.history).toEqual([]);
  });

  it('does not repeat the reply the visitor has already read', async () => {
    /*
     * Both attempts answer the same question. Letting the repair's prose
     * through would show two replies to it, and the second would arrive after
     * the visitor had finished reading the first.
     */
    const { provider } = scripted(
      [
        { type: 'text', delta: 'Le consiglio un Barolo.' },
        { type: 'error', code: 'schema_invalid' },
      ],
      [
        { type: 'text', delta: 'Le consiglio un Barolo.' },
        { type: 'recommendations', items: [card()] },
      ],
    );

    expect(text(await run(provider))).toBe('Le consiglio un Barolo.');
  });

  it("uses the repair's reply when the first attempt wrote none", async () => {
    // The tool-call case: the model produced no prose at all, so the repair's
    // reply is the only reply there is and suppressing it leaves a blank answer.
    const { provider } = scripted(
      [{ type: 'error', code: 'schema_invalid' }],
      [
        { type: 'text', delta: 'Le consiglio un Barolo.' },
        { type: 'recommendations', items: [card()] },
      ],
    );

    expect(text(await run(provider))).toBe('Le consiglio un Barolo.');
  });
});

describe('when the repair misses the schema too', () => {
  it('keeps the reply and says there are no cards', async () => {
    const { provider } = scripted(
      [
        { type: 'text', delta: 'Con la bistecca va bene un rosso strutturato.' },
        { type: 'error', code: 'schema_invalid' },
      ],
      [{ type: 'error', code: 'schema_invalid' }],
    );
    const onOutcome = vi.fn();

    const chunks = await run(provider, onOutcome);

    expect(text(chunks)).toBe('Con la bistecca va bene un rosso strutturato.');
    expect(cards(chunks)).toEqual([]);
    expect(chunks).toContainEqual({ type: 'recommendations', items: [] });
    expect(onOutcome).toHaveBeenCalledWith('schema_failed');
  });

  it('never builds a card out of output that did not validate', async () => {
    const { provider } = scripted(
      [
        { type: 'text', delta: 'Un rosso.' },
        { type: 'error', code: 'schema_invalid' },
      ],
      [{ type: 'error', code: 'schema_invalid' }],
    );

    expect(cards(await run(provider))).toEqual([]);
  });

  it('errors only when there is no reply to fall back on', async () => {
    // Nothing to degrade to: a silent success here would be a widget that
    // finished and said nothing.
    const { provider } = scripted(
      [{ type: 'error', code: 'schema_invalid' }],
      [{ type: 'error', code: 'schema_invalid' }],
    );

    expect(await run(provider)).toContainEqual({ type: 'error', code: 'schema_invalid' });
  });

  it('stops after the second attempt, whatever happens', async () => {
    /*
     * The only latency guarantee this layer can make, so it is the one it
     * makes: a model that missed the schema twice will miss it a third time,
     * and the visitor has been waiting for both.
     */
    const { provider, attempts } = scripted(
      [{ type: 'error', code: 'schema_invalid' }],
      [{ type: 'error', code: 'schema_invalid' }],
      [{ type: 'recommendations', items: [card()] }],
    );

    await run(provider);

    expect(attempts()).toBe(2);
  });
});

describe('failures that are not the schema', () => {
  it('does not retry a refusal', async () => {
    // The model declined. Asking the same model the same question again is a
    // round trip spent to be declined a second time.
    const { provider, attempts } = scripted([{ type: 'error', code: 'refusal' }]);
    const onOutcome = vi.fn();

    const chunks = await run(provider, onOutcome);

    expect(chunks).toContainEqual({ type: 'error', code: 'refusal' });
    expect(attempts()).toBe(1);
    expect(onOutcome).toHaveBeenCalledWith('refusal');
  });

  it('does not retry a provider error', async () => {
    const { provider, attempts } = scripted([{ type: 'error', code: 'provider_error' }]);
    const onOutcome = vi.fn();

    await run(provider, onOutcome);

    expect(attempts()).toBe(1);
    expect(onOutcome).toHaveBeenCalledWith('provider_error');
  });
});

describe('the reply a visitor can be shown', () => {
  it('stops at the length the schema promises', async () => {
    /*
     * `MAX_REPLY_CHARACTERS` is what a *parsed* reply is capped at, so a
     * streamed one that runs longer is a model ignoring its instructions rather
     * than a longer answer worth reading. Capped here because an answer arrives
     * in one delta or fifty, and the cap is a property of the answer.
     */
    const { provider } = scripted([
      { type: 'text', delta: 'a'.repeat(MAX_REPLY_CHARACTERS - 1) },
      { type: 'text', delta: 'bbb' },
      { type: 'text', delta: 'ccc' },
    ]);

    expect(text(await run(provider))).toHaveLength(MAX_REPLY_CHARACTERS);
  });

  it('caps the repair too, when the repair is the one doing the writing', async () => {
    const { provider } = scripted(
      [{ type: 'error', code: 'schema_invalid' }],
      [
        { type: 'text', delta: 'y'.repeat(MAX_REPLY_CHARACTERS + 200) },
        { type: 'recommendations', items: [card()] },
      ],
    );

    expect(text(await run(provider))).toHaveLength(MAX_REPLY_CHARACTERS);
  });

  it('reports the outcome exactly once', async () => {
    // P2-31 writes one `usage_events` row per turn; two calls would be two
    // rows, and the schema-failure rate §4.5 disqualifies a model on would be
    // measured against a denominator that counted some turns twice.
    const { provider } = scripted(
      [{ type: 'error', code: 'schema_invalid' }],
      [{ type: 'recommendations', items: [card()] }],
    );
    const onOutcome = vi.fn();

    await run(provider, onOutcome);

    expect(onOutcome).toHaveBeenCalledTimes(1);
  });
});
