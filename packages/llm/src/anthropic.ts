import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
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
 * Claude on the Anthropic API, behind P1-41's port (P1-44) — the third
 * candidate in P1-47's bake-off, with the same contract as Nova and Gemini.
 *
 * **Structured output through `output_config.format`.** The schema is P2-24's,
 * passed through the SDK's own `jsonSchemaOutputFormat`, which keeps what
 * structured outputs enforce and moves the bounds it does not (lengths, counts,
 * the confidence range) into descriptions the model still reads. As with
 * Gemini, the answer is JSON text, so it is accumulated and checked before the
 * reply is said, never streamed as fragments.
 *
 * **The stop reason is read before the content.** A refusal arrives as a
 * successful response with `stop_reason: 'refusal'`, and whatever text came
 * before it is not an answer, however well-formed it looks.
 *
 * **The key is passed in, never read from the environment**: given none, the
 * SDK would look for `ANTHROPIC_API_KEY`, a token or a login profile.
 */

/** A pairing is a few hundred tokens of JSON; a truncated answer fails validation and is counted. */
export const ANTHROPIC_MAX_TOKENS = 1024;

/** The same as the other adapters, so the bake-off compares models rather than settings. */
export const ANTHROPIC_TEMPERATURE = 0.3;

export interface AnthropicOptions {
  /** The Claude model id. Required, as the other adapters' are: the model is P1-47's decision. */
  readonly model: string;
  /** For logs and the bake-off table. Defaults to `anthropic:<model>`. */
  readonly id?: string | undefined;
  /** Read from SSM by the caller. Required unless a client is supplied. */
  readonly apiKey?: string | undefined;
  readonly client?: Anthropic | undefined;
  readonly maxTokens?: number | undefined;
  /**
   * `null` sends no temperature at all. Models released after Claude Opus 4.6
   * reject any value but 1.0, so a caller trying one of them needs a way to
   * omit it; Haiku 4.5, the bake-off's candidate, accepts one.
   */
  readonly temperature?: number | null | undefined;
  /** Tokens per call, cache reads and writes included, for `usage_events`. */
  readonly onUsage?: ((usage: PairingUsage) => void) | undefined;
}

/** History and prompt as Messages API turns, each text a block of its own. */
export const toAnthropicMessages = (
  history: readonly Turn[],
  user: string,
): Anthropic.MessageParam[] =>
  alternatingTurns(history, user).map(({ role, texts }) => ({
    role,
    content: texts.map((text) => ({ type: 'text', text })),
  }));

/** The streaming request for one pairing. Exported so its shape is testable without a stream. */
export const anthropicRequest = (
  model: string,
  prompt: ReturnType<typeof buildPairingPrompt>,
  options: Pick<AnthropicOptions, 'maxTokens' | 'temperature'> = {},
): Anthropic.MessageCreateParamsStreaming => {
  const { schema } = jsonSchemaOutputFormat(pairingJsonSchema() as { type: 'object' });
  const temperature =
    options.temperature === undefined ? ANTHROPIC_TEMPERATURE : options.temperature;

  return {
    model,
    max_tokens: options.maxTokens ?? ANTHROPIC_MAX_TOKENS,
    ...(temperature === null ? {} : { temperature }),
    // The instructions are byte-identical across requests, so they carry the
    // cache breakpoint; everything that varies comes after it.
    system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
    messages: toAnthropicMessages(prompt.history, prompt.user),
    output_config: { format: { type: 'json_schema', schema } },
    stream: true,
  };
};

const toUsage = (
  start: Anthropic.Usage | undefined,
  delta: Anthropic.MessageDeltaUsage | undefined,
): PairingUsage => ({
  // `message_delta` carries the final counts where it has them; the rest were
  // settled in `message_start`. Anthropic already reports cache reads and
  // writes apart from `input_tokens`, which is the port's shape.
  inputTokens: delta?.input_tokens ?? start?.input_tokens ?? 0,
  outputTokens: delta?.output_tokens ?? start?.output_tokens ?? 0,
  cacheReadInputTokens: delta?.cache_read_input_tokens ?? start?.cache_read_input_tokens ?? 0,
  cacheWriteInputTokens:
    delta?.cache_creation_input_tokens ?? start?.cache_creation_input_tokens ?? 0,
});

const clientFor = (options: AnthropicOptions): Anthropic => {
  if (options.client !== undefined) return options.client;

  if (options.apiKey === undefined || options.apiKey === '') {
    throw new Error(
      'Anthropic needs an apiKey or a client; without one the SDK would look for credentials in the environment',
    );
  }

  return new Anthropic({ apiKey: options.apiKey });
};

export const anthropicProvider = (options: AnthropicOptions): LlmProvider => {
  const client = clientFor(options);

  return {
    id: options.id ?? `anthropic:${options.model}`,

    streamPairing: (request, signal) =>
      (async function* (): AsyncGenerator<PairingChunk> {
        // Read through a function: the signal can flip while this waits on the stream.
        const aborted = (): boolean => signal.aborted;

        if (aborted()) return;

        const params = anthropicRequest(options.model, buildPairingPrompt(request), options);

        let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
        try {
          stream = await client.messages.create(params, { signal });
        } catch {
          if (!aborted()) yield PROVIDER_ERROR;
          return;
        }

        let text = '';
        let stopReason: Anthropic.StopReason | null = null;
        let startUsage: Anthropic.Usage | undefined;
        let deltaUsage: Anthropic.MessageDeltaUsage | undefined;

        try {
          for await (const event of stream) {
            if (aborted()) return;

            if (event.type === 'message_start') startUsage = event.message.usage;

            // Thinking deltas are the model's working, not its answer.
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              text += event.delta.text;
            }

            if (event.type === 'message_delta') {
              stopReason = event.delta.stop_reason ?? stopReason;
              deltaUsage = event.usage;
            }
          }
        } catch {
          if (!aborted()) yield PROVIDER_ERROR;
          return;
        }

        if (startUsage !== undefined || deltaUsage !== undefined) {
          options.onUsage?.(toUsage(startUsage, deltaUsage));
        }

        if (stopReason === 'refusal') {
          yield { type: 'error', code: 'refusal' };
          return;
        }

        const pairing = trustedPairing(text);
        if (pairing === undefined) {
          yield { type: 'error', code: 'schema_invalid' };
          return;
        }

        if (pairing.reply !== '') yield { type: 'text', delta: pairing.reply };

        yield { type: 'recommendations', items: pairing.recommendations };
      })(),
  };
};
