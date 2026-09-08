import { assertProviderFitsColumn } from '@catalogorosso/core';
import { describe, expect, it, vi } from 'vitest';

import {
  TITAN_DIMENSIONS,
  TITAN_MODEL,
  TITAN_PROVENANCE,
  titanEmbeddingProvider,
  truncateForTitan,
} from '../src/providers/titan.js';

/**
 * The Titan adapter (P1-36).
 *
 * The Bedrock client is injected, so none of this needs credentials, a network
 * or a mocked cloud — which is the same reason the *port* lives in
 * `packages/core` and this adapter does not (P0-09).
 *
 * **The integration test the row asks for is deliberately absent.** It would
 * need Bedrock model access granted in the account, which has not happened, and
 * a test that silently skips when a credential is missing is a test that
 * reports success for never running. It belongs with P1-47's bake-off, where
 * real calls are the point.
 */

const vector = (fill = 0) => Array.from({ length: TITAN_DIMENSIONS }, () => fill);

const respond = (body: unknown) => ({
  body: new TextEncoder().encode(JSON.stringify(body)),
});

const named = (name: string) => Object.assign(new Error(name), { name });

interface Sent {
  readonly input: { readonly modelId: string; readonly body: string };
}
type Send = (command: Sent) => Promise<unknown>;

const provider = (send: Send | ReturnType<typeof vi.fn>, overrides = {}) =>
  titanEmbeddingProvider({
    client: { send } as never,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...overrides,
  });

describe('the request', () => {
  it('asks for a normalised 1024-dimensional vector', async () => {
    /*
     * Captured in a closure rather than read back off `mock.calls`, so the
     * command keeps its type instead of arriving as `unknown` and needing a
     * cast that says nothing.
     */
    let sent: Sent | undefined;
    const send = vi.fn((command: Sent) => {
      sent = command;
      return Promise.resolve(respond({ embedding: vector() }));
    });

    await provider(send).embed(['Barolo Bussia']);

    if (sent === undefined) {
      throw new Error('expected one call to Bedrock');
    }

    const command = sent;
    const body = JSON.parse(command.input.body) as Record<string, unknown>;

    expect(command.input.modelId).toBe(TITAN_MODEL);
    /*
     * **`normalize` is not a formatting preference.** Normalised vectors make
     * cosine distance equivalent to inner product and keep magnitudes
     * consistent, so a long tasting note does not outrank a short one for
     * having more words in it. Mixing normalised and unnormalised vectors in
     * one index gives answers that are wrong in a way nothing reports.
     */
    expect(body).toMatchObject({ inputText: 'Barolo Bussia', dimensions: 1024, normalize: true });
  });

  it('declares a dimension the column will accept', () => {
    /*
     * The pairing this exists for: a provider whose vectors do not fit is a
     * boot failure rather than a wave of insert errors that read as embedding
     * failures.
     */
    expect(() => assertProviderFitsColumn(provider(vi.fn()), 1024)).not.toThrow();
    expect(() => assertProviderFitsColumn(provider(vi.fn()), 1536)).toThrow();
  });

  it('records what the vectors were built from, not only which model', () => {
    /*
     * The same model over different *text* produces a different embedding, so
     * the model alone does not identify a vector — which is what
     * EMBEDDING_TEXT_VERSION exists to make visible (P1-33).
     */
    expect(TITAN_PROVENANCE).toBe(`${TITAN_MODEL}/v1`);
  });
});

describe('batching', () => {
  it('embeds every text and keeps them in order', async () => {
    /*
     * **Order is the property that fails silently.** A fan-out that returned
     * results in completion order would pair each vector with whichever product
     * happened to finish in that slot — retrieval would work and every wine
     * would be described by another one.
     */
    const send = vi.fn((command: { input: { body: string } }) => {
      const { inputText } = JSON.parse(command.input.body) as { inputText: string };
      return Promise.resolve(respond({ embedding: vector(inputText.length) }));
    });

    const vectors = await provider(send).embed(['a', 'bb', 'ccc']);

    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3]);
  });

  it('makes one call per text, because Titan embeds one at a time', async () => {
    const send = vi.fn(() => Promise.resolve(respond({ embedding: vector() })));

    await provider(send).embed(['a', 'b', 'c', 'd']);

    expect(send).toHaveBeenCalledTimes(4);
  });

  it('does not fan out further than the pool allows', async () => {
    /*
     * A hundred simultaneous calls is how one worker throttles itself and every
     * other worker at the same time. The pool is why the batch-first signature
     * exists: the loop lives here rather than in every caller.
     */
    let inFlight = 0;
    let peak = 0;

    const send = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return respond({ embedding: vector() });
    });

    await provider(send).embed(Array.from({ length: 40 }, (_, i) => String(i)));

    expect(peak).toBeLessThanOrEqual(5);
  });

  it('accepts an empty batch without calling anything', async () => {
    const send = vi.fn();

    expect(await provider(send).embed([])).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('retrying', () => {
  it.each([
    'ThrottlingException',
    'TooManyRequestsException',
    'ServiceUnavailableException',
    'ModelTimeoutException',
    'InternalServerException',
  ])('retries a %s', async (name) => {
    let calls = 0;
    const send = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(named(name))
        : Promise.resolve(respond({ embedding: vector() }));
    });

    await expect(provider(send).embed(['a'])).resolves.toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not retry a validation error', async () => {
    /*
     * Ours to fix. Repeating it turns one mistake into four and then lands the
     * message in the DLQ looking like a provider problem — precisely the
     * confusion P1-50 exists to resolve.
     */
    const send = vi.fn(() => Promise.reject(named('ValidationException')));

    await expect(provider(send).embed(['a'])).rejects.toThrow('ValidationException');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives up rather than retrying for ever', async () => {
    const send = vi.fn(() => Promise.reject(named('ThrottlingException')));

    await expect(provider(send).embed(['a'])).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('jitters the backoff, so a throttled batch does not retry in lockstep', async () => {
    /*
     * The calls that hit the cap arrive together — a bulk import fans out five
     * at a time from every worker — and a batch that all waits the same
     * interval hits the limit again. Same reasoning as P0-64's email backoff.
     */
    const waits: number[] = [];
    let calls = 0;
    const send = vi.fn(() => {
      calls += 1;
      return calls < 3
        ? Promise.reject(named('ThrottlingException'))
        : Promise.resolve(respond({ embedding: vector() }));
    });

    const randoms = [0.1, 0.9];
    let index = 0;

    await titanEmbeddingProvider({
      client: { send } as never,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      random: () => randoms[index++ % randoms.length] ?? 0.5,
    }).embed(['a']);

    expect(waits).toHaveLength(2);
    expect(waits[0]).not.toBe(waits[1]);
  });

  it('refuses a response with no embedding in it', async () => {
    const send = vi.fn(() => Promise.resolve(respond({ note: 'nothing useful' })));

    await expect(provider(send).embed(['a'])).rejects.toThrow(/no embedding/);
  });
});

describe('truncateForTitan', () => {
  const LIMIT = 8_192 * 4;

  it('leaves a normal tasting note alone', () => {
    const note = 'Rosa appassita, catrame e ciliegia sotto spirito.';

    expect(truncateForTitan(note)).toBe(note);
  });

  it('cuts at a sentence boundary rather than mid-clause', () => {
    /*
     * **A hard cut mid-sentence is worse than a shorter document.** It can end
     * on a fragment that inverts the clause before it — a note ending "non
     * adatto a" says the opposite of what the seller wrote.
     */
    const sentence = 'Vino rosso strutturato e tannico. ';
    const long = sentence.repeat(Math.ceil(LIMIT / sentence.length) + 1);

    const cut = truncateForTitan(long);

    expect(cut.length).toBeLessThanOrEqual(LIMIT);
    expect(cut.endsWith('.')).toBe(true);
  });

  it('falls back to a word boundary when there is no sentence to cut at', () => {
    const long = 'parola '.repeat(Math.ceil(LIMIT / 7) + 10);

    const cut = truncateForTitan(long);

    expect(cut.length).toBeLessThanOrEqual(LIMIT);
    expect(cut.endsWith('parola')).toBe(true);
  });

  it('reports the truncation rather than doing it silently', () => {
    /*
     * An input this long usually means somebody pasted a whole page into a
     * field, and the seller is the only person who can fix that.
     */
    const seen: { from: number; to: number }[] = [];
    truncateForTitan('a'.repeat(LIMIT + 500), (info) => {
      seen.push(info);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.from).toBe(LIMIT + 500);
  });

  it('says nothing when nothing was cut', () => {
    const seen: unknown[] = [];
    truncateForTitan('short', (info) => {
      seen.push(info);
    });

    expect(seen).toEqual([]);
  });
});

describe('its defaults', () => {
  it('builds its own Bedrock client when none is supplied', () => {
    /*
     * Construction only — no call is made — so this needs no credentials and no
     * network. What it pins is that the production path does not require an
     * injected client, which is the shape every other test bypasses.
     */
    const built = titanEmbeddingProvider();

    expect(built.model).toBe(TITAN_MODEL);
    expect(built.dim).toBe(TITAN_DIMENSIONS);
  });

  it('waits on a real timer between retries when no sleep is injected', async () => {
    /*
     * `random: () => 0` makes the backoff zero, so this exercises the default
     * `setTimeout` path for the price of a tick rather than of a real wait —
     * and the path is worth exercising, because it is the one production uses
     * and the only one no other test touches.
     */
    let calls = 0;
    const send = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(named('ThrottlingException'))
        : Promise.resolve(respond({ embedding: vector() }));
    });

    await titanEmbeddingProvider({ client: { send } as never, random: () => 0 }).embed(['a']);

    expect(send).toHaveBeenCalledTimes(2);
  });
});
