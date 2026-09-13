import { randomUUID } from 'node:crypto';

import {
  BlockedReason,
  FinishReason,
  GenerateContentResponse,
  Type,
  type Content,
  type GenerateContentParameters,
  type GoogleGenAI,
} from '@google/genai';
import {
  MAX_REASON_CHARACTERS,
  MAX_RECOMMENDATIONS,
  MAX_REPLY_CHARACTERS,
  pairingJsonSchema,
  pairingSystemPrompt,
  type PairingRequest,
} from '@catalogorosso/core';
import { describe, expect, it, vi } from 'vitest';

import {
  GEMINI_MAX_TOKENS,
  GEMINI_TEMPERATURE,
  geminiProvider,
  toGeminiContents,
  toGeminiSchema,
} from '../src/gemini.js';
import type { PairingUsage } from '../src/usage.js';
import {
  answer,
  describeProviderContract,
  drain,
  pairingRequest,
  scriptedStream,
  type FakeOptions,
  type ProviderFakes,
} from './provider-contract.js';

/**
 * The Gemini adapter (P1-43), against a fake client.
 *
 * The shared provider suite is the row's test. What stays here is Gemini's
 * own: its finish reasons and prompt blocks as refusals, thought parts that are
 * not the answer, usage that counts cached tokens inside the prompt, and the
 * request — above all the schema projection, because a projection Gemini
 * rejects fails every request while every fake-driven test still passes.
 */

const MODEL = 'gemini-3.1-flash-lite';

type Fields = Pick<GenerateContentResponse, 'candidates' | 'promptFeedback' | 'usageMetadata'>;

const response = (fields: Fields): GenerateContentResponse =>
  Object.assign(new GenerateContentResponse(), fields);

const text = (value: string, finishReason?: FinishReason): GenerateContentResponse =>
  response({
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: value }] },
        ...(finishReason === undefined ? {} : { finishReason }),
      },
    ],
  });

/** Structured output split across events, the way a stream delivers it. */
const answerEvents = (json: string, usage?: Fields['usageMetadata']): GenerateContentResponse[] => [
  text(json.slice(0, 15)),
  text(json.slice(15, 40)),
  response({
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: json.slice(40) }] },
        finishReason: FinishReason.STOP,
      },
    ],
    ...(usage === undefined ? {} : { usageMetadata: usage }),
  }),
];

/** Gemini wired to a client whose stream yields `events`. */
const geminiFake = (
  events: readonly GenerateContentResponse[],
  options: FakeOptions & { maxTokens?: number; temperature?: number } = {},
  behaviour: { reject?: () => void; thenThrow?: boolean } = {},
) => {
  const counter = { count: 0 };
  const generateContentStream = vi.fn<
    (params: GenerateContentParameters) => Promise<AsyncGenerator<GenerateContentResponse>>
  >(() => {
    if (behaviour.reject !== undefined) {
      behaviour.reject();
      return Promise.reject(new Error('429 RESOURCE_EXHAUSTED'));
    }
    return Promise.resolve(
      scriptedStream(events, counter, {
        onPull: options.onPull,
        thenThrow: behaviour.thenThrow === true,
      }),
    );
  });

  return {
    generateContentStream,
    provider: geminiProvider({
      model: MODEL,
      client: { models: { generateContentStream } } as unknown as GoogleGenAI,
      onUsage: options.onUsage,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    }),
    calls: () => generateContentStream.mock.calls.length,
    pulled: () => counter.count,
    signal: () => generateContentStream.mock.calls.at(-1)?.[0].config?.abortSignal,
  };
};

const geminiFakes: ProviderFakes = {
  answering: (json, options = {}) =>
    geminiFake(
      answerEvents(
        json,
        options.usage === undefined
          ? undefined
          : {
              promptTokenCount: options.usage.input + options.usage.cacheRead,
              cachedContentTokenCount: options.usage.cacheRead,
              candidatesTokenCount: options.usage.output,
            },
      ),
      options,
    ),
  refusing: () => geminiFake([text('{"reply": "Con'), text('', FinishReason.SAFETY)]),
  rejecting: (before = () => undefined) => geminiFake([], {}, { reject: before }),
  breaking: () => geminiFake([text('{"reply": "Con il')], {}, { thenThrow: true }),
};

describeProviderContract('Gemini', geminiFakes);

const run = (events: readonly GenerateContentResponse[], options: FakeOptions = {}) =>
  drain(
    geminiFake(events, options).provider.streamPairing(
      pairingRequest(),
      new AbortController().signal,
    ),
  );

describe('what only Gemini does', () => {
  it.each([
    FinishReason.SAFETY,
    FinishReason.RECITATION,
    FinishReason.LANGUAGE,
    FinishReason.BLOCKLIST,
    FinishReason.PROHIBITED_CONTENT,
    FinishReason.SPII,
    FinishReason.IMAGE_SAFETY,
    FinishReason.IMAGE_PROHIBITED_CONTENT,
  ])('reports a %s finish as a refusal, whatever text came first', async (reason) => {
    expect(await run([text(answer()), text('', reason)])).toEqual([
      { type: 'error', code: 'refusal' },
    ]);
  });

  it('reports a blocked prompt as a refusal', async () => {
    expect(
      await run([response({ promptFeedback: { blockReason: BlockedReason.PROHIBITED_CONTENT } })]),
    ).toEqual([{ type: 'error', code: 'refusal' }]);
  });

  it('reports an answer cut off at the token cap as schema_invalid, not a refusal', async () => {
    expect(await run([text(answer().slice(0, 30), FinishReason.MAX_TOKENS)])).toEqual([
      { type: 'error', code: 'schema_invalid' },
    ]);
  });

  it('never takes a thought summary for part of the answer', async () => {
    const received = await run([
      response({
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'Il brasato vuole tannino.', thought: true }, { text: answer() }],
            },
            finishReason: FinishReason.STOP,
          },
        ],
      }),
    ]);

    expect(received.at(-1)?.type).toBe('recommendations');
  });

  it('bills thinking as output, and reports zero for any usage field left out', async () => {
    const usages: PairingUsage[] = [];
    const onUsage = (usage: PairingUsage) => usages.push(usage);

    await run(
      answerEvents(answer(), {
        promptTokenCount: 1000,
        candidatesTokenCount: 90,
        thoughtsTokenCount: 200,
      }),
      { onUsage },
    );
    await run(answerEvents(answer(), {}), { onUsage });

    expect(usages).toEqual([
      { inputTokens: 1000, outputTokens: 290, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    ]);
  });
});

describe('the request', () => {
  const sent = async (
    request: PairingRequest = pairingRequest(),
    options: { maxTokens?: number; temperature?: number } = {},
  ) => {
    const fake = geminiFake(answerEvents(answer()), options);
    await drain(fake.provider.streamPairing(request, new AbortController().signal));
    const params = fake.generateContentStream.mock.calls[0]?.[0];
    if (params === undefined) throw new Error('expected a request');
    return params;
  };

  it('puts the shared instructions in the system instruction, and asks for JSON in the shared schema', async () => {
    const params = await sent();

    expect(params.model).toBe(MODEL);
    expect(params.config?.systemInstruction).toBe(pairingSystemPrompt());
    expect(params.config?.responseMimeType).toBe('application/json');
    expect(params.config?.responseSchema).toEqual(toGeminiSchema(pairingJsonSchema()));
  });

  it('caps the output and keeps the temperature low, unless told otherwise', async () => {
    const defaults = (await sent()).config;
    expect([defaults?.maxOutputTokens, defaults?.temperature]).toEqual([
      GEMINI_MAX_TOKENS,
      GEMINI_TEMPERATURE,
    ]);

    const chosen = (await sent(pairingRequest(), { maxTokens: 256, temperature: 0.7 })).config;
    expect([chosen?.maxOutputTokens, chosen?.temperature]).toEqual([256, 0.7]);
  });

  it('sends history with the model role, and the delimited question last', async () => {
    const params = await sent(
      pairingRequest({
        history: [
          { role: 'user', content: 'Ciao' },
          { role: 'assistant', content: 'Per cosa?' },
        ],
      }),
    );

    const [first, second, last] = params.contents as Content[];

    expect([first?.role, second?.role, last?.role]).toEqual(['user', 'model', 'user']);
    expect(second?.parts).toEqual([{ text: 'Per cosa?' }]);
    expect(last?.parts?.[0]?.text).toContain('<messaggio_visitatore lingua="it">');
  });

  it('names itself after the model unless given an id', () => {
    const client = {} as GoogleGenAI;

    expect(geminiProvider({ model: MODEL, client }).id).toBe(`gemini:${MODEL}`);
    expect(geminiProvider({ model: MODEL, id: 'flash-lite', client }).id).toBe('flash-lite');
  });

  it('builds its own client from a key it is given', () => {
    expect(geminiProvider({ model: MODEL, apiKey: randomUUID() }).id).toBe(`gemini:${MODEL}`);
  });

  it.each([
    ['no key', undefined],
    ['an empty key', ''],
  ])('refuses to start with %s, rather than let the SDK read the environment', (_case, apiKey) => {
    expect(() => geminiProvider({ model: MODEL, apiKey })).toThrow(/apiKey or a client/);
  });
});

describe('toGeminiSchema', () => {
  it('projects the pairing schema: structure, bounds and order, and nothing Gemini rejects', () => {
    expect(toGeminiSchema(pairingJsonSchema())).toEqual({
      type: Type.OBJECT,
      properties: {
        reply: { type: Type.STRING, maxLength: String(MAX_REPLY_CHARACTERS) },
        recommendations: {
          type: Type.ARRAY,
          maxItems: String(MAX_RECOMMENDATIONS),
          items: {
            type: Type.OBJECT,
            properties: {
              productId: { type: Type.STRING },
              reason: {
                type: Type.STRING,
                minLength: '1',
                maxLength: String(MAX_REASON_CHARACTERS),
              },
              confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
            },
            propertyOrdering: ['productId', 'reason', 'confidence'],
            required: ['productId', 'reason', 'confidence'],
          },
        },
      },
      propertyOrdering: ['reply', 'recommendations'],
      required: ['reply', 'recommendations'],
    });
  });

  it('keeps the reply ahead of the recommendations', () => {
    expect(toGeminiSchema(pairingJsonSchema()).propertyOrdering?.[0]).toBe('reply');
  });

  it('carries minimum counts and an unbounded number, and an object with nothing declared', () => {
    expect(
      toGeminiSchema({ type: 'array', minItems: 1, items: { type: 'number', maximum: 5 } }),
    ).toEqual({ type: Type.ARRAY, minItems: '1', items: { type: Type.NUMBER, maximum: 5 } });
    expect(toGeminiSchema({ type: 'object' })).toEqual({
      type: Type.OBJECT,
      properties: {},
      propertyOrdering: [],
      required: [],
    });
  });

  it.each([
    ['a type it has no mapping for', { type: 'boolean' }],
    ['an array with no item schema', { type: 'array' }],
    ['something that is not a schema', null],
  ])('throws for %s, so a schema change fails a test rather than a request', (_case, node) => {
    expect(() => toGeminiSchema(node)).toThrow(/Gemini's response schema/);
  });
});

describe('toGeminiContents', () => {
  it('uses the model role for the assistant, over alternating turns', () => {
    expect(
      toGeminiContents(
        [
          { role: 'assistant', content: 'Benvenuto' },
          { role: 'user', content: 'Ciao' },
          { role: 'assistant', content: 'Per cosa?' },
        ],
        'PROMPT',
      ),
    ).toEqual([
      { role: 'user', parts: [{ text: 'Ciao' }] },
      { role: 'model', parts: [{ text: 'Per cosa?' }] },
      { role: 'user', parts: [{ text: 'PROMPT' }] },
    ]);
  });
});
