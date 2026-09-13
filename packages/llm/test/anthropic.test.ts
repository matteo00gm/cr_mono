import { randomUUID } from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';
import { pairingSystemPrompt, type PairingRequest } from '@catalogorosso/core';
import { describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_TEMPERATURE,
  anthropicProvider,
  toAnthropicMessages,
} from '../src/anthropic.js';
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
 * The Anthropic adapter (P1-44), against a fake client.
 *
 * The shared provider suite is the row's test. What stays here is Anthropic's
 * own: the refusal stop reason, which arrives as a successful response and is
 * read before any content; thinking deltas that are not the answer; usage split
 * across the start and delta events; and the request — the cache breakpoint,
 * and the schema as structured outputs will accept it.
 */

const MODEL = 'claude-haiku-4-5';

type Event = Anthropic.RawMessageStreamEvent;

interface UsageCounts {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
}

const messageStart = (usage: UsageCounts = {}): Event =>
  ({
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: MODEL, usage },
  }) as unknown as Event;

const textDelta = (text: string): Event => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text },
});

const messageDelta = (stopReason: Anthropic.StopReason, usage?: UsageCounts): Event =>
  ({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    ...(usage === undefined ? {} : { usage }),
  }) as unknown as Event;

/** A text answer split across deltas, framed the way the API frames it. */
const answerEvents = (json: string, start?: UsageCounts, end?: UsageCounts): Event[] => [
  messageStart(start),
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '', citations: null },
  },
  textDelta(json.slice(0, 15)),
  textDelta(json.slice(15, 40)),
  textDelta(json.slice(40)),
  { type: 'content_block_stop', index: 0 },
  messageDelta('end_turn', end),
  { type: 'message_stop' },
];

type Create = (
  params: Anthropic.MessageCreateParamsStreaming,
  options?: { signal?: AbortSignal },
) => Promise<AsyncIterable<Event>>;

/** Claude wired to a client whose stream yields `events`. */
const anthropicFake = (
  events: readonly Event[],
  options: FakeOptions & { maxTokens?: number; temperature?: number | null } = {},
  behaviour: { reject?: () => void; thenThrow?: boolean } = {},
) => {
  const counter = { count: 0 };
  const create = vi.fn<Create>(() => {
    if (behaviour.reject !== undefined) {
      behaviour.reject();
      return Promise.reject(new Error('529 overloaded'));
    }
    return Promise.resolve(
      scriptedStream(events, counter, {
        onPull: options.onPull,
        thenThrow: behaviour.thenThrow === true,
      }),
    );
  });

  return {
    create,
    provider: anthropicProvider({
      model: MODEL,
      client: { messages: { create } } as unknown as Anthropic,
      onUsage: options.onUsage,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    }),
    calls: () => create.mock.calls.length,
    pulled: () => counter.count,
    signal: () => create.mock.calls.at(-1)?.[1]?.signal,
  };
};

const anthropicFakes: ProviderFakes = {
  answering: (json, options = {}) =>
    anthropicFake(
      options.usage === undefined
        ? answerEvents(json)
        : answerEvents(
            json,
            {
              input_tokens: options.usage.input,
              output_tokens: 1,
              cache_read_input_tokens: options.usage.cacheRead,
              cache_creation_input_tokens: 0,
            },
            {
              input_tokens: null,
              output_tokens: options.usage.output,
              cache_read_input_tokens: null,
              cache_creation_input_tokens: null,
            },
          ),
      options,
    ),
  refusing: () =>
    anthropicFake([messageStart(), textDelta('{"reply": "Con'), messageDelta('refusal')]),
  rejecting: (before = () => undefined) => anthropicFake([], {}, { reject: before }),
  breaking: () =>
    anthropicFake([messageStart(), textDelta('{"reply": "Con il')], {}, { thenThrow: true }),
};

describeProviderContract('Anthropic', anthropicFakes);

const run = (events: readonly Event[], options: FakeOptions = {}) =>
  drain(
    anthropicFake(events, options).provider.streamPairing(
      pairingRequest(),
      new AbortController().signal,
    ),
  );

describe('what only Anthropic does', () => {
  it('reads a refusal stop before the content, however valid the text before it looks', async () => {
    expect(await run([messageStart(), textDelta(answer()), messageDelta('refusal')])).toEqual([
      { type: 'error', code: 'refusal' },
    ]);
  });

  it('reports an answer cut off at max_tokens as schema_invalid, not a refusal', async () => {
    expect(
      await run([messageStart(), textDelta(answer().slice(0, 30)), messageDelta('max_tokens')]),
    ).toEqual([{ type: 'error', code: 'schema_invalid' }]);
  });

  it('never takes a thinking delta for part of the answer', async () => {
    const received = await run([
      messageStart(),
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Il brasato vuole tannino.' },
      },
      textDelta(answer()),
      messageDelta('end_turn'),
    ]);

    expect(received.at(-1)?.type).toBe('recommendations');
  });

  it('takes final counts from the delta where it has them, and the rest from the start', async () => {
    const usages: PairingUsage[] = [];
    const onUsage = (usage: PairingUsage) => usages.push(usage);

    await run(
      answerEvents(
        answer(),
        {
          input_tokens: 1000,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 2000,
        },
        {
          input_tokens: 1200,
          output_tokens: 90,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      ),
      { onUsage },
    );
    await run(
      [
        messageStart({ input_tokens: 10, output_tokens: 1 }),
        textDelta(answer()),
        messageDelta('end_turn'),
      ],
      { onUsage },
    );
    await run([textDelta(answer()), messageDelta('end_turn', { output_tokens: 5 })], { onUsage });

    expect(usages).toEqual([
      { inputTokens: 1200, outputTokens: 90, cacheReadInputTokens: 0, cacheWriteInputTokens: 2000 },
      { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      { inputTokens: 0, outputTokens: 5, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    ]);
  });

  it('reports no usage when the stream carried none', async () => {
    const usages: PairingUsage[] = [];

    await run([textDelta(answer())], { onUsage: (usage) => usages.push(usage) });

    expect(usages).toEqual([]);
  });
});

describe('the request', () => {
  const sent = async (
    request: PairingRequest = pairingRequest(),
    options: { maxTokens?: number; temperature?: number | null } = {},
  ) => {
    const fake = anthropicFake(answerEvents(answer()), options);
    await drain(fake.provider.streamPairing(request, new AbortController().signal));
    const params = fake.create.mock.calls[0]?.[0];
    if (params === undefined) throw new Error('expected a request');
    return params;
  };

  it('streams, with the shared instructions as the system prompt and the cache breakpoint on them', async () => {
    const params = await sent();

    expect(params.model).toBe(MODEL);
    expect(params.stream).toBe(true);
    expect(params.system).toEqual([
      { type: 'text', text: pairingSystemPrompt(), cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('asks for the shared schema, as structured outputs accept it', async () => {
    const format = (await sent()).output_config?.format;
    const schema = format?.schema as {
      additionalProperties?: unknown;
      properties: {
        reply: Record<string, unknown>;
        recommendations: {
          items: {
            additionalProperties?: unknown;
            properties: Record<string, Record<string, unknown>>;
          };
        };
      };
    };

    expect(format?.type).toBe('json_schema');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.recommendations.items.additionalProperties).toBe(false);
    expect(schema.properties.recommendations.items.properties.productId?.format).toBe('uuid');
    // Bounds structured outputs cannot enforce are carried as text the model reads.
    expect(schema.properties.reply.maxLength).toBeUndefined();
    expect(schema.properties.reply.description).toContain('maxLength: 1200');
  });

  it('caps the output and keeps the temperature low, unless told otherwise', async () => {
    // Read through a plain shape: the SDK marks `temperature` deprecated, and
    // what is under test is what this adapter sends.
    const settings = (params: object) => params as { max_tokens?: number; temperature?: number };

    const defaults = settings(await sent());
    expect([defaults.max_tokens, defaults.temperature]).toEqual([
      ANTHROPIC_MAX_TOKENS,
      ANTHROPIC_TEMPERATURE,
    ]);

    const chosen = settings(await sent(pairingRequest(), { maxTokens: 256, temperature: 0.7 }));
    expect([chosen.max_tokens, chosen.temperature]).toEqual([256, 0.7]);
  });

  it('sends no temperature at all when told null, for models that reject one', async () => {
    expect('temperature' in (await sent(pairingRequest(), { temperature: null }))).toBe(false);
  });

  it('hands the signal to the SDK as a request option', async () => {
    const fake = anthropicFake(answerEvents(answer()));
    const controller = new AbortController();

    await drain(fake.provider.streamPairing(pairingRequest(), controller.signal));

    expect(fake.create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it('sends history as alternating turns, and the delimited question last', async () => {
    const params = await sent(
      pairingRequest({
        history: [
          { role: 'assistant', content: 'Benvenuto' },
          { role: 'user', content: 'Ciao' },
          { role: 'assistant', content: 'Per cosa?' },
        ],
      }),
    );

    expect(params.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(params.messages.at(-1)?.content)).toContain(
      '<messaggio_visitatore lingua=\\"it\\">',
    );
  });

  it('names itself after the model unless given an id', () => {
    const client = {} as Anthropic;

    expect(anthropicProvider({ model: MODEL, client }).id).toBe(`anthropic:${MODEL}`);
    expect(anthropicProvider({ model: MODEL, id: 'haiku', client }).id).toBe('haiku');
  });

  it('builds its own client from a key it is given', () => {
    expect(anthropicProvider({ model: MODEL, apiKey: randomUUID() }).id).toBe(`anthropic:${MODEL}`);
  });

  it.each([
    ['no key', undefined],
    ['an empty key', ''],
  ])('refuses to start with %s, rather than let the SDK read the environment', (_case, apiKey) => {
    expect(() => anthropicProvider({ model: MODEL, apiKey })).toThrow(/apiKey or a client/);
  });
});

describe('toAnthropicMessages', () => {
  it('carries each turn as text blocks', () => {
    expect(
      toAnthropicMessages(
        [
          { role: 'user', content: 'Ciao' },
          { role: 'user', content: 'Mi serve un vino' },
        ],
        'PROMPT',
      ),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Ciao' },
          { type: 'text', text: 'Mi serve un vino' },
          { type: 'text', text: 'PROMPT' },
        ],
      },
    ]);
  });
});
