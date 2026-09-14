import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type BedrockRuntimeClientConfig,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import {
  buildPairingPrompt,
  pairingJsonSchema,
  type LlmProvider,
  type PairingChunk,
  type Turn,
} from '@catalogorosso/core';

import { PROVIDER_ERROR, trustedPairing } from './pairing.js';
import { alternatingTurns } from './turns.js';
import type { PairingUsage } from './usage.js';

/**
 * Amazon Nova on Bedrock, behind P1-41's port (P1-42, §4.5's default).
 *
 * **Structured output through a forced tool.** Nova has no response-schema
 * mode, so the request offers exactly one tool, `emit_pairings`, whose input
 * schema is P2-24's, and requires the model to call it. The tool's arguments
 * are the answer: parsed, validated and checked for leaked instructions before
 * any recommendation leaves this file. Anything that fails becomes a
 * `schema_invalid` chunk, never an exception and never a card.
 *
 * **Prompt caching on the stable prefix.** The system prompt from P2-23 is
 * byte-identical across requests and is followed by a cache point; everything
 * that varies sits after it. Whether the cache actually hits is asserted by the
 * live test, run with the bake-off, because a silently cold cache is a cost
 * regression no functional test notices.
 */

/** The one tool the model is offered and required to call. */
export const PAIRING_TOOL = 'emit_pairings';

/** A pairing is a few hundred tokens of JSON; this leaves room without inviting an essay. */
export const NOVA_MAX_TOKENS = 1024;

/** Low, because the answer is a choice among given wines rather than creative writing. */
export const NOVA_TEMPERATURE = 0.3;

export interface NovaOptions {
  /**
   * The Bedrock model or inference-profile id. Required rather than defaulted:
   * which Nova, and which regional profile, is P1-47's decision per environment,
   * and a default here would quietly become that decision.
   */
  readonly modelId: string;
  /** For logs and the bake-off table. Defaults to `bedrock:<modelId>`. */
  readonly id?: string | undefined;
  readonly client?: BedrockRuntimeClient | undefined;
  readonly config?: BedrockRuntimeClientConfig | undefined;
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
  /** Tokens per call, cache reads included, for `usage_events` and the cache-hit assertion. */
  readonly onUsage?: ((usage: PairingUsage) => void) | undefined;
}

/** Turns as the strictly alternating messages Converse requires; see `alternatingTurns`. */
export const toNovaMessages = (history: readonly Turn[], user: string): Message[] =>
  alternatingTurns(history, user).map(({ role, texts }) => ({
    role,
    content: texts.map((text) => ({ text })),
  }));

/** The Converse request for one pairing. Exported so its shape is testable without a stream. */
export const novaRequest = (
  modelId: string,
  prompt: ReturnType<typeof buildPairingPrompt>,
  options: Pick<NovaOptions, 'maxTokens' | 'temperature'> = {},
): ConverseStreamCommandInput => ({
  modelId,
  system: [{ text: prompt.system }, { cachePoint: { type: 'default' } }],
  messages: toNovaMessages(prompt.history, prompt.user),
  inferenceConfig: {
    maxTokens: options.maxTokens ?? NOVA_MAX_TOKENS,
    temperature: options.temperature ?? NOVA_TEMPERATURE,
  },
  toolConfig: {
    tools: [
      {
        toolSpec: {
          name: PAIRING_TOOL,
          description: 'Return the reply to the visitor and the recommended wines.',
          inputSchema: { json: pairingJsonSchema() as never },
        },
      },
    ],
    toolChoice: { tool: { name: PAIRING_TOOL } },
  },
});

/** Stop reasons meaning the model or a guardrail declined, which arrive as a successful stream. */
const REFUSALS: ReadonlySet<string> = new Set(['content_filtered', 'guardrail_intervened']);

const isStreamError = (event: ConverseStreamOutput): boolean =>
  event.internalServerException !== undefined ||
  event.modelStreamErrorException !== undefined ||
  event.serviceUnavailableException !== undefined ||
  event.throttlingException !== undefined ||
  event.validationException !== undefined;

export const bedrockNovaProvider = (options: NovaOptions): LlmProvider => {
  const client = options.client ?? new BedrockRuntimeClient(options.config ?? {});

  return {
    id: options.id ?? `bedrock:${options.modelId}`,

    streamPairing: (request, signal) =>
      (async function* (): AsyncGenerator<PairingChunk> {
        /*
         * Read through a function rather than the property: the signal can flip
         * while this generator waits on the stream, and a narrowed
         * `signal.aborted` would let the compiler believe it never can.
         */
        const aborted = (): boolean => signal.aborted;

        if (aborted()) return;

        const input = novaRequest(options.modelId, buildPairingPrompt(request), options);

        let stream: AsyncIterable<ConverseStreamOutput> | undefined;
        try {
          // The signal goes to the SDK, not only to the loop below: aborting has to
          // cancel the request in flight, or the generation runs on and is billed.
          ({ stream } = await client.send(new ConverseStreamCommand(input), {
            abortSignal: signal,
          }));
        } catch {
          if (!aborted()) yield PROVIDER_ERROR;
          return;
        }

        if (stream === undefined) {
          yield PROVIDER_ERROR;
          return;
        }

        let toolInput = '';
        let textStreamed = false;
        let stopReason: string | undefined;

        try {
          for await (const event of stream) {
            if (aborted()) return;

            if (isStreamError(event)) {
              yield PROVIDER_ERROR;
              return;
            }

            const text = event.contentBlockDelta?.delta?.text;
            if (text !== undefined && text !== '') {
              textStreamed = true;
              yield { type: 'text', delta: text };
            }

            toolInput += event.contentBlockDelta?.delta?.toolUse?.input ?? '';
            stopReason = event.messageStop?.stopReason ?? stopReason;

            const usage = event.metadata?.usage;
            if (usage !== undefined) {
              options.onUsage?.({
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
                cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
              });
            }
          }
        } catch {
          if (!aborted()) yield PROVIDER_ERROR;
          return;
        }

        if (stopReason !== undefined && REFUSALS.has(stopReason)) {
          yield { type: 'error', code: 'refusal' };
          return;
        }

        // Empty input is the case where the model never called the tool at all.
        const pairing = trustedPairing(toolInput);
        if (pairing === undefined) {
          yield { type: 'error', code: 'schema_invalid' };
          return;
        }

        // Nova usually puts the whole reply inside the tool call; say it as text
        // unless the model already streamed text of its own.
        if (!textStreamed && pairing.reply !== '') yield { type: 'text', delta: pairing.reply };

        yield { type: 'recommendations', items: pairing.recommendations };
      })(),
  };
};
