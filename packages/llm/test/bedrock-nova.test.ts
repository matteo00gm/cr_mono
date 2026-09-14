import {
  ConverseStreamCommand,
  type BedrockRuntimeClient,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { pairingJsonSchema, pairingSystemPrompt, type PairingRequest } from '@catalogorosso/core';
import { describe, expect, it, vi } from 'vitest';

import {
  bedrockNovaProvider,
  NOVA_MAX_TOKENS,
  NOVA_TEMPERATURE,
  PAIRING_TOOL,
  toNovaMessages,
} from '../src/bedrock-nova.js';
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
 * The Bedrock Nova adapter (P1-42), against a fake client.
 *
 * The shared provider suite covers the row's tests — a mocked stream produces
 * the expected chunks, malformed tool JSON yields `schema_invalid` rather than
 * throwing, abort stops consumption. What stays here is Nova's own: text the
 * model streams beside the tool call, its refusal stop reasons and exception
 * events, and the request, because a wrong cache point or an unforced tool
 * fails quietly — the answers still arrive, slower, dearer, or without a
 * schema.
 */

const MODEL = 'eu.amazon.nova-lite-v1:0';

const toolDelta = (input: string): ConverseStreamOutput => ({
  contentBlockDelta: { delta: { toolUse: { input } }, contentBlockIndex: 0 },
});

const textDelta = (text: string): ConverseStreamOutput => ({
  contentBlockDelta: { delta: { text }, contentBlockIndex: 0 },
});

const stop = (stopReason: string): ConverseStreamOutput => ({
  messageStop: { stopReason: stopReason as never },
});

/** A tool call split across deltas, the way a stream delivers it. */
const toolCall = (json: string): ConverseStreamOutput[] => [
  {
    contentBlockStart: {
      start: { toolUse: { toolUseId: 't-1', name: PAIRING_TOOL } },
      contentBlockIndex: 0,
    },
  },
  toolDelta(json.slice(0, 20)),
  toolDelta(json.slice(20)),
  { contentBlockStop: { contentBlockIndex: 0 } },
  stop('tool_use'),
];

type Send = (
  command: ConverseStreamCommand,
  options?: { abortSignal?: AbortSignal },
) => Promise<{ stream?: AsyncIterable<ConverseStreamOutput> }>;

/** Nova wired to a client whose stream yields `events`. */
const novaFake = (
  events: readonly ConverseStreamOutput[],
  options: FakeOptions & { maxTokens?: number; temperature?: number } = {},
  behaviour: { reject?: () => void; thenThrow?: boolean; noStream?: boolean } = {},
) => {
  const counter = { count: 0 };
  const send = vi.fn<Send>(() => {
    if (behaviour.reject !== undefined) {
      behaviour.reject();
      return Promise.reject(Object.assign(new Error('rate'), { name: 'ThrottlingException' }));
    }
    if (behaviour.noStream === true) return Promise.resolve({});
    return Promise.resolve({
      stream: scriptedStream(events, counter, {
        onPull: options.onPull,
        thenThrow: behaviour.thenThrow === true,
      }),
    });
  });

  return {
    send,
    provider: bedrockNovaProvider({
      modelId: MODEL,
      client: { send } as unknown as BedrockRuntimeClient,
      onUsage: options.onUsage,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    }),
    calls: () => send.mock.calls.length,
    pulled: () => counter.count,
    signal: () => send.mock.calls.at(-1)?.[1]?.abortSignal,
  };
};

const novaFakes: ProviderFakes = {
  answering: (json, options = {}) =>
    novaFake(
      [
        ...toolCall(json),
        ...(options.usage === undefined
          ? []
          : [
              {
                metadata: {
                  usage: {
                    inputTokens: options.usage.input,
                    outputTokens: options.usage.output,
                    totalTokens: options.usage.input + options.usage.output,
                    cacheReadInputTokens: options.usage.cacheRead,
                  },
                  metrics: { latencyMs: 400 },
                },
              },
            ]),
      ],
      options,
    ),
  refusing: () => novaFake([...toolCall(answer()).slice(0, -1), stop('content_filtered')]),
  rejecting: (before = () => undefined) => novaFake([], {}, { reject: before }),
  breaking: () => novaFake([textDelta('Inizio'), toolDelta('{"reply":')], {}, { thenThrow: true }),
};

describeProviderContract('Nova', novaFakes);

const run = (events: readonly ConverseStreamOutput[], request: PairingRequest = pairingRequest()) =>
  drain(novaFake(events).provider.streamPairing(request, new AbortController().signal));

describe('what only Nova does', () => {
  it('streams text the model writes itself, and does not repeat the reply after it', async () => {
    const received = await run([
      textDelta('Allora, '),
      textDelta('per il brasato…'),
      ...toolCall(answer()),
    ]);

    expect(received.filter((chunk) => chunk.type === 'text')).toEqual([
      { type: 'text', delta: 'Allora, ' },
      { type: 'text', delta: 'per il brasato…' },
    ]);
    expect(received.at(-1)?.type).toBe('recommendations');
  });

  it('yields schema_invalid when the model answers in text and never calls the tool', async () => {
    expect((await run([textDelta('Consiglio il Barolo.'), stop('end_turn')])).at(-1)).toEqual({
      type: 'error',
      code: 'schema_invalid',
    });
  });

  it.each(['content_filtered', 'guardrail_intervened'])(
    'reports a %s stop as a refusal, even when the stream succeeded',
    async (reason) => {
      expect(await run([...toolCall(answer()).slice(0, -1), stop(reason)])).toEqual([
        { type: 'error', code: 'refusal' },
      ]);
    },
  );

  it.each([
    'internalServerException',
    'modelStreamErrorException',
    'serviceUnavailableException',
    'throttlingException',
    'validationException',
  ])('reports a %s inside the stream as a provider error, and stops', async (member) => {
    const fake = novaFake([
      textDelta('Inizio'),
      { [member]: { message: 'boom' } } as unknown as ConverseStreamOutput,
      ...toolCall(answer()),
    ]);

    expect(
      await drain(fake.provider.streamPairing(pairingRequest(), new AbortController().signal)),
    ).toEqual([
      { type: 'text', delta: 'Inizio' },
      { type: 'error', code: 'provider_error' },
    ]);
    expect(fake.pulled()).toBe(2);
  });

  it('reports a response with no stream as a provider error', async () => {
    const fake = novaFake([], {}, { noStream: true });

    expect(
      await drain(fake.provider.streamPairing(pairingRequest(), new AbortController().signal)),
    ).toEqual([{ type: 'error', code: 'provider_error' }]);
  });
});

describe('the request', () => {
  const sent = async (
    request: PairingRequest = pairingRequest(),
    options: { maxTokens?: number; temperature?: number } = {},
  ) => {
    const fake = novaFake(toolCall(answer()), options);
    await drain(fake.provider.streamPairing(request, new AbortController().signal));
    const command = fake.send.mock.calls[0]?.[0];
    if (!(command instanceof ConverseStreamCommand))
      throw new Error('expected a ConverseStream command');
    return command.input;
  };

  it('puts the instructions first and a cache point straight after them', async () => {
    const input = await sent();

    expect(input.modelId).toBe(MODEL);
    expect(input.system).toEqual([
      { text: pairingSystemPrompt() },
      { cachePoint: { type: 'default' } },
    ]);
  });

  it('forces the one pairing tool, whose input schema is the shared one', async () => {
    const input = await sent();

    expect(input.toolConfig?.toolChoice).toEqual({ tool: { name: PAIRING_TOOL } });
    expect(input.toolConfig?.tools).toHaveLength(1);
    expect(input.toolConfig?.tools?.[0]?.toolSpec?.inputSchema).toEqual({
      json: pairingJsonSchema(),
    });
  });

  it('caps the output and keeps the temperature low, unless told otherwise', async () => {
    expect((await sent()).inferenceConfig).toEqual({
      maxTokens: NOVA_MAX_TOKENS,
      temperature: NOVA_TEMPERATURE,
    });
    expect(
      (await sent(pairingRequest(), { maxTokens: 256, temperature: 0.7 })).inferenceConfig,
    ).toEqual({
      maxTokens: 256,
      temperature: 0.7,
    });
  });

  it('sends the delimited candidates and question as the last user message', async () => {
    const input = await sent();
    const last = input.messages?.at(-1);

    expect(last?.role).toBe('user');
    expect(JSON.stringify(last?.content)).toContain('<messaggio_visitatore lingua=\\"it\\">');
  });

  it('sends history as alternating Converse messages', async () => {
    const input = await sent(
      pairingRequest({
        history: [
          { role: 'assistant', content: 'Benvenuto' },
          { role: 'user', content: 'Ciao' },
          { role: 'assistant', content: 'Per cosa?' },
        ],
      }),
    );

    expect(input.messages?.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(input.messages?.[0]?.content).toEqual([{ text: 'Ciao' }]);
  });

  it('reports zero for any usage field the provider left out', async () => {
    const usages: PairingUsage[] = [];
    const fake = novaFake(
      [...toolCall(answer()), { metadata: { usage: {} as never, metrics: { latencyMs: 1 } } }],
      { onUsage: (usage) => usages.push(usage) },
    );

    await drain(fake.provider.streamPairing(pairingRequest(), new AbortController().signal));

    expect(usages).toEqual([
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    ]);
  });

  it('names itself after the model unless given an id', () => {
    const { send } = novaFake([]);
    const client = { send } as unknown as BedrockRuntimeClient;

    expect(bedrockNovaProvider({ modelId: MODEL, client }).id).toBe(`bedrock:${MODEL}`);
    expect(bedrockNovaProvider({ modelId: MODEL, id: 'nova-lite', client }).id).toBe('nova-lite');
  });

  it('builds its own client when none is supplied', () => {
    expect(bedrockNovaProvider({ modelId: MODEL, config: { region: 'eu-west-1' } }).id).toBe(
      `bedrock:${MODEL}`,
    );
  });
});

describe('toNovaMessages', () => {
  it('carries each turn as text blocks', () => {
    expect(
      toNovaMessages(
        [
          { role: 'user', content: 'Ciao' },
          { role: 'user', content: 'Mi serve un vino' },
        ],
        'PROMPT',
      ),
    ).toEqual([
      {
        role: 'user',
        content: [{ text: 'Ciao' }, { text: 'Mi serve un vino' }, { text: 'PROMPT' }],
      },
    ]);
  });
});
