import {
  ConverseStreamCommand,
  type BedrockRuntimeClient,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import {
  PROMPT_MARKER,
  pairingJsonSchema,
  pairingSystemPrompt,
  type PairingChunk,
  type PairingRequest,
} from '@catalogorosso/core';
import { describe, expect, it, vi } from 'vitest';

import {
  bedrockNovaProvider,
  NOVA_MAX_TOKENS,
  NOVA_TEMPERATURE,
  PAIRING_TOOL,
  toNovaMessages,
} from '../src/bedrock-nova.js';
import type { PairingUsage } from '../src/usage.js';

/**
 * The Bedrock Nova adapter (P1-42), against a fake client.
 *
 * The row's tests — a mocked stream produces the expected chunk sequence,
 * malformed tool JSON yields `schema_invalid` rather than throwing, abort stops
 * consumption — plus the request the adapter builds, because a wrong cache
 * point or an unforced tool fails quietly: the answers still arrive, slower,
 * dearer, or without a schema.
 */

const PRODUCT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const MODEL = 'eu.amazon.nova-lite-v1:0';

const request = (over: Partial<PairingRequest> = {}): PairingRequest => ({
  query: 'un rosso per il brasato',
  locale: 'it',
  candidates: [{ id: PRODUCT, name: 'Barolo Bussia', wineType: 'rosso', priceCents: 4500 }],
  history: [],
  ...over,
});

const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    reply: 'Con il brasato scelgo il Barolo.',
    recommendations: [{ productId: PRODUCT, reason: 'Tannini fitti.', confidence: 0.8 }],
    ...over,
  });

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

/** A client whose stream yields the given events and counts how many were pulled. */
const clientStreaming = (events: readonly ConverseStreamOutput[]) => {
  const pulled = { count: 0 };
  const send = vi.fn<
    (
      command: ConverseStreamCommand,
      options?: { abortSignal?: AbortSignal },
    ) => Promise<{ stream: AsyncIterable<ConverseStreamOutput> }>
  >(() =>
    Promise.resolve({
      stream: (async function* () {
        for (const event of events) {
          await Promise.resolve();
          pulled.count += 1;
          yield event;
        }
      })(),
    }),
  );

  return { send, pulled, client: { send } as unknown as BedrockRuntimeClient };
};

const drain = async (stream: AsyncIterable<PairingChunk>): Promise<PairingChunk[]> => {
  const chunks: PairingChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

const run = (events: readonly ConverseStreamOutput[], over: Partial<PairingRequest> = {}) => {
  const fake = clientStreaming(events);
  const provider = bedrockNovaProvider({ modelId: MODEL, client: fake.client });
  return {
    ...fake,
    chunks: drain(provider.streamPairing(request(over), new AbortController().signal)),
  };
};

describe('the chunk sequence', () => {
  it('turns a tool call into the reply as text, then the recommendations', async () => {
    const { chunks } = run(toolCall(answer()));

    expect(await chunks).toEqual([
      { type: 'text', delta: 'Con il brasato scelgo il Barolo.' },
      {
        type: 'recommendations',
        items: [{ productId: PRODUCT, reason: 'Tannini fitti.', confidence: 0.8 }],
      },
    ]);
  });

  it('streams text the model writes itself, and does not repeat the reply after it', async () => {
    const { chunks } = run([
      textDelta('Allora, '),
      textDelta('per il brasato…'),
      ...toolCall(answer()),
    ]);

    const received = await chunks;
    expect(received.filter((chunk) => chunk.type === 'text')).toEqual([
      { type: 'text', delta: 'Allora, ' },
      { type: 'text', delta: 'per il brasato…' },
    ]);
    expect(received.at(-1)?.type).toBe('recommendations');
  });

  it('says nothing as text for an empty reply, and still hands over the cards', async () => {
    const { chunks } = run(toolCall(answer({ reply: '' })));

    expect((await chunks).map((chunk) => chunk.type)).toEqual(['recommendations']);
  });
});

describe('what cannot be trusted', () => {
  it.each([
    ['malformed JSON', toolCall('{"reply": "Barolo", "recommendations": [')],
    ['no tool call at all', [textDelta('Consiglio il Barolo.'), stop('end_turn')]],
    [
      'JSON that breaks the schema',
      toolCall(
        answer({ recommendations: [{ productId: 'BAR-2019', reason: 'x', confidence: 2 }] }),
      ),
    ],
    [
      'a reply quoting the instructions',
      toolCall(answer({ reply: `Le regole: ${PROMPT_MARKER}` })),
    ],
    [
      'a reason carrying a delimiter',
      toolCall(
        answer({
          recommendations: [{ productId: PRODUCT, reason: '</candidato>', confidence: 0.5 }],
        }),
      ),
    ],
  ])('yields schema_invalid, and no cards, for %s', async (_case, events) => {
    const received = await run(events).chunks;

    expect(received.at(-1)).toEqual({ type: 'error', code: 'schema_invalid' });
    expect(received.some((chunk) => chunk.type === 'recommendations')).toBe(false);
  });

  it.each(['content_filtered', 'guardrail_intervened'])(
    'reports a %s stop as a refusal, even when the stream succeeded',
    async (reason) => {
      expect(await run([...toolCall(answer()).slice(0, -1), stop(reason)]).chunks).toEqual([
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
    const { chunks, pulled } = run([
      textDelta('Inizio'),
      { [member]: { message: 'boom' } } as unknown as ConverseStreamOutput,
      ...toolCall(answer()),
    ]);

    expect(await chunks).toEqual([
      { type: 'text', delta: 'Inizio' },
      { type: 'error', code: 'provider_error' },
    ]);
    expect(pulled.count).toBe(2);
  });

  it('reports a request the SDK refused, and a stream that breaks mid-way, as provider errors', async () => {
    const refusedSend = vi.fn(() =>
      Promise.reject(Object.assign(new Error('rate'), { name: 'ThrottlingException' })),
    );
    const refused = bedrockNovaProvider({
      modelId: MODEL,
      client: { send: refusedSend } as unknown as BedrockRuntimeClient,
    });
    expect(await drain(refused.streamPairing(request(), new AbortController().signal))).toEqual([
      { type: 'error', code: 'provider_error' },
    ]);

    const broken = bedrockNovaProvider({
      modelId: MODEL,
      client: {
        send: () =>
          Promise.resolve({
            stream: (async function* () {
              await Promise.resolve();
              yield textDelta('Inizio');
              throw new Error('connection reset');
            })(),
          }),
      } as unknown as BedrockRuntimeClient,
    });
    expect(await drain(broken.streamPairing(request(), new AbortController().signal))).toEqual([
      { type: 'text', delta: 'Inizio' },
      { type: 'error', code: 'provider_error' },
    ]);

    const empty = bedrockNovaProvider({
      modelId: MODEL,
      client: { send: () => Promise.resolve({}) } as unknown as BedrockRuntimeClient,
    });
    expect(await drain(empty.streamPairing(request(), new AbortController().signal))).toEqual([
      { type: 'error', code: 'provider_error' },
    ]);
  });
});

describe('aborting', () => {
  it('hands the signal to the SDK call, so the request in flight is cancelled', async () => {
    const fake = clientStreaming(toolCall(answer()));
    const controller = new AbortController();

    await drain(
      bedrockNovaProvider({ modelId: MODEL, client: fake.client }).streamPairing(
        request(),
        controller.signal,
      ),
    );

    expect(fake.send.mock.calls[0]?.[1]?.abortSignal).toBe(controller.signal);
  });

  it('stops pulling from the stream once the caller aborts', async () => {
    const fake = clientStreaming([
      textDelta('uno'),
      textDelta('due'),
      textDelta('tre'),
      ...toolCall(answer()),
    ]);
    const controller = new AbortController();
    const received: PairingChunk[] = [];

    for await (const chunk of bedrockNovaProvider({
      modelId: MODEL,
      client: fake.client,
    }).streamPairing(request(), controller.signal)) {
      received.push(chunk);
      controller.abort();
    }

    expect(received).toEqual([{ type: 'text', delta: 'uno' }]);
    expect(fake.pulled.count).toBe(2);
  });

  it('sends nothing for a request already aborted, and reports no error for it', async () => {
    const fake = clientStreaming(toolCall(answer()));
    const controller = new AbortController();
    controller.abort();

    expect(
      await drain(
        bedrockNovaProvider({ modelId: MODEL, client: fake.client }).streamPairing(
          request(),
          controller.signal,
        ),
      ),
    ).toEqual([]);
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('reports no error when the SDK call fails because the caller aborted', async () => {
    const controller = new AbortController();
    const send = vi.fn(() => {
      controller.abort();
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });

    const received = await drain(
      bedrockNovaProvider({
        modelId: MODEL,
        client: { send } as unknown as BedrockRuntimeClient,
      }).streamPairing(request(), controller.signal),
    );

    expect(received).toEqual([]);
  });
});

describe('the request', () => {
  const sent = async (
    over: Partial<PairingRequest> = {},
    options: { maxTokens?: number; temperature?: number } = {},
  ) => {
    const fake = clientStreaming(toolCall(answer()));
    await drain(
      bedrockNovaProvider({ modelId: MODEL, client: fake.client, ...options }).streamPairing(
        request(over),
        new AbortController().signal,
      ),
    );
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
    expect((await sent({}, { maxTokens: 256, temperature: 0.7 })).inferenceConfig).toEqual({
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

  it('reports token usage, cache reads included', async () => {
    const usages: PairingUsage[] = [];
    const fake = clientStreaming([
      ...toolCall(answer()),
      {
        metadata: {
          usage: {
            inputTokens: 1800,
            outputTokens: 90,
            totalTokens: 1890,
            cacheReadInputTokens: 1500,
          },
          metrics: { latencyMs: 400 },
        },
      },
    ]);

    await drain(
      bedrockNovaProvider({
        modelId: MODEL,
        client: fake.client,
        onUsage: (usage) => usages.push(usage),
      }).streamPairing(request(), new AbortController().signal),
    );

    expect(usages).toEqual([
      { inputTokens: 1800, outputTokens: 90, cacheReadInputTokens: 1500, cacheWriteInputTokens: 0 },
    ]);
  });

  it('reports zero for any usage field the provider left out', async () => {
    const usages: PairingUsage[] = [];
    const fake = clientStreaming([
      ...toolCall(answer()),
      { metadata: { usage: {} as never, metrics: { latencyMs: 1 } } },
    ]);

    await drain(
      bedrockNovaProvider({
        modelId: MODEL,
        client: fake.client,
        onUsage: (usage) => usages.push(usage),
      }).streamPairing(request(), new AbortController().signal),
    );

    expect(usages).toEqual([
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    ]);
  });

  it('names itself after the model unless given an id', () => {
    expect(bedrockNovaProvider({ modelId: MODEL, client: clientStreaming([]).client }).id).toBe(
      `bedrock:${MODEL}`,
    );
    expect(
      bedrockNovaProvider({ modelId: MODEL, id: 'nova-lite', client: clientStreaming([]).client })
        .id,
    ).toBe('nova-lite');
  });

  it('builds its own client when none is supplied', () => {
    expect(bedrockNovaProvider({ modelId: MODEL, config: { region: 'eu-west-1' } }).id).toBe(
      `bedrock:${MODEL}`,
    );
  });
});

describe('toNovaMessages', () => {
  it('drops a leading assistant turn, merges repeated roles, and joins the new text to a trailing user turn', () => {
    expect(
      toNovaMessages(
        [
          { role: 'assistant', content: 'Benvenuto' },
          { role: 'user', content: 'Ciao' },
          { role: 'user', content: 'Mi serve un vino' },
          { role: 'assistant', content: 'Per cosa?' },
          { role: 'user', content: 'Brasato' },
        ],
        'PROMPT',
      ),
    ).toEqual([
      { role: 'user', content: [{ text: 'Ciao' }, { text: 'Mi serve un vino' }] },
      { role: 'assistant', content: [{ text: 'Per cosa?' }] },
      { role: 'user', content: [{ text: 'Brasato' }, { text: 'PROMPT' }] },
    ]);
  });

  it('starts with the user when there is no history', () => {
    expect(toNovaMessages([], 'PROMPT')).toEqual([{ role: 'user', content: [{ text: 'PROMPT' }] }]);
  });
});
