import {
  FinishReason,
  GoogleGenAI,
  Type,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  type Schema,
} from '@google/genai';
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
 * Gemini, behind P1-41's port (P1-43) — a peer of Nova, not a fallback, because
 * it has to be a genuine candidate in P1-47's bake-off.
 *
 * **Structured output through a response schema.** The request asks for
 * `application/json` with a `responseSchema` projected from P2-24's, so the
 * model's whole text is the answer. That text is JSON, so it is never streamed
 * to the visitor as it arrives: it is accumulated, then parsed, validated and
 * checked for leaked instructions exactly as Nova's tool input is, and the
 * reply is said once it has passed. The price is time to first token, which
 * the bake-off measures.
 *
 * **The key is passed in, never read from the environment.** Given none, the
 * SDK falls back to `GEMINI_API_KEY`; the key lives in SSM, and a copy in the
 * function's environment would be a second place to leak it from.
 */

/** A pairing is a few hundred tokens of JSON; this leaves room without inviting an essay. */
export const GEMINI_MAX_TOKENS = 1024;

/** Low, because the answer is a choice among given wines rather than creative writing. */
export const GEMINI_TEMPERATURE = 0.3;

export interface GeminiOptions {
  /**
   * The Gemini model id. Required rather than defaulted, as Nova's is: which
   * model is P1-47's decision, and a default here would quietly make it.
   */
  readonly model: string;
  /** For logs and the bake-off table. Defaults to `gemini:<model>`. */
  readonly id?: string | undefined;
  /** Read from SSM by the caller. Required unless a client is supplied. */
  readonly apiKey?: string | undefined;
  readonly client?: GoogleGenAI | undefined;
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
  /** Tokens per call, cache reads included, for `usage_events`. */
  readonly onUsage?: ((usage: PairingUsage) => void) | undefined;
}

interface JsonSchema {
  readonly type?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
  readonly items?: unknown;
  readonly minItems?: unknown;
  readonly maxItems?: unknown;
  readonly minLength?: unknown;
  readonly maxLength?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
}

const isObject = (value: unknown): value is JsonSchema & Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A JSON Schema as the OpenAPI subset Gemini's `responseSchema` accepts.
 *
 * An allowlist, not a copy: Gemini rejects keywords outside its subset, so
 * only structure and bounds cross over. `additionalProperties`, `format` and
 * `pattern` are dropped — none is needed for the model to produce the shape,
 * and `parsePairingOutput` still refuses an unknown key's value or an id that
 * is not a UUID, counting it toward the schema-failure rate. Lengths and counts
 * are int64 strings in Gemini's schema. Property order is kept explicitly,
 * because Gemini otherwise orders keys itself and the reply should come first.
 * A type this cannot express throws, so a schema change fails a test rather
 * than a request.
 */
export const toGeminiSchema = (node: unknown): Schema => {
  if (!isObject(node)) throw new Error("Gemini's response schema needs an object at every level");

  switch (node.type) {
    case 'object': {
      const properties = Object.entries(isObject(node.properties) ? node.properties : {});
      return {
        type: Type.OBJECT,
        properties: Object.fromEntries(
          properties.map(([name, child]) => [name, toGeminiSchema(child)]),
        ),
        propertyOrdering: properties.map(([name]) => name),
        required: Array.isArray(node.required)
          ? node.required.filter((name): name is string => typeof name === 'string')
          : [],
      };
    }
    case 'array': {
      const schema: Schema = { type: Type.ARRAY, items: toGeminiSchema(node.items) };
      if (typeof node.minItems === 'number') schema.minItems = String(node.minItems);
      if (typeof node.maxItems === 'number') schema.maxItems = String(node.maxItems);
      return schema;
    }
    case 'string': {
      const schema: Schema = { type: Type.STRING };
      if (typeof node.minLength === 'number') schema.minLength = String(node.minLength);
      if (typeof node.maxLength === 'number') schema.maxLength = String(node.maxLength);
      return schema;
    }
    case 'number': {
      const schema: Schema = { type: Type.NUMBER };
      if (typeof node.minimum === 'number') schema.minimum = node.minimum;
      if (typeof node.maximum === 'number') schema.maximum = node.maximum;
      return schema;
    }
    default:
      throw new Error(
        `Gemini's response schema has no mapping for type ${JSON.stringify(node.type)}`,
      );
  }
};

/** History and prompt as Gemini contents, whose assistant role is `model`. */
export const toGeminiContents = (history: readonly Turn[], user: string): Content[] =>
  alternatingTurns(history, user).map(({ role, texts }) => ({
    role: role === 'assistant' ? 'model' : 'user',
    parts: texts.map((text) => ({ text })),
  }));

/** The request for one pairing. Exported so its shape is testable without a stream. */
export const geminiRequest = (
  model: string,
  prompt: ReturnType<typeof buildPairingPrompt>,
  options: Pick<GeminiOptions, 'maxTokens' | 'temperature'> = {},
): GenerateContentParameters => ({
  model,
  contents: toGeminiContents(prompt.history, prompt.user),
  config: {
    // First, and byte-identical across requests, so Gemini's implicit prefix
    // cache can serve it.
    systemInstruction: prompt.system,
    responseMimeType: 'application/json',
    responseSchema: toGeminiSchema(pairingJsonSchema()),
    maxOutputTokens: options.maxTokens ?? GEMINI_MAX_TOKENS,
    temperature: options.temperature ?? GEMINI_TEMPERATURE,
  },
});

/** Finish reasons meaning the model or a safety system declined, over a stream that succeeded. */
const REFUSALS: ReadonlySet<FinishReason> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.LANGUAGE,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
  FinishReason.IMAGE_PROHIBITED_CONTENT,
]);

const toUsage = (usage: GenerateContentResponseUsageMetadata): PairingUsage => {
  const cached = usage.cachedContentTokenCount ?? 0;

  return {
    // Gemini counts cached tokens inside the prompt; the port reports them
    // apart, as Bedrock does, so a cache hit is not billed twice in a report.
    inputTokens: (usage.promptTokenCount ?? 0) - cached,
    // Thinking is billed as output, so it is counted as output.
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cacheReadInputTokens: cached,
    cacheWriteInputTokens: 0,
  };
};

const clientFor = (options: GeminiOptions): GoogleGenAI => {
  if (options.client !== undefined) return options.client;

  if (options.apiKey === undefined || options.apiKey === '') {
    throw new Error(
      'Gemini needs an apiKey or a client; without one the SDK would read GEMINI_API_KEY from the environment',
    );
  }

  return new GoogleGenAI({ apiKey: options.apiKey });
};

export const geminiProvider = (options: GeminiOptions): LlmProvider => {
  const client = clientFor(options);

  return {
    id: options.id ?? `gemini:${options.model}`,

    streamPairing: (request, signal) =>
      (async function* (): AsyncGenerator<PairingChunk> {
        // Read through a function: the signal can flip while this waits on the stream.
        const aborted = (): boolean => signal.aborted;

        if (aborted()) return;

        const params = geminiRequest(options.model, buildPairingPrompt(request), options);

        let stream: AsyncIterable<GenerateContentResponse>;
        try {
          stream = await client.models.generateContentStream({
            ...params,
            // The SDK closes the connection on abort. Its own documentation warns
            // that this does not promise the service stops generating, which the
            // bake-off's cost figures have to allow for.
            config: { ...params.config, abortSignal: signal },
          });
        } catch {
          if (!aborted()) yield PROVIDER_ERROR;
          return;
        }

        let text = '';
        let blocked = false;
        let finishReason: FinishReason | undefined;
        let usage: GenerateContentResponseUsageMetadata | undefined;

        try {
          for await (const event of stream) {
            if (aborted()) return;

            blocked ||= event.promptFeedback?.blockReason !== undefined;

            const candidate = event.candidates?.[0];
            for (const part of candidate?.content?.parts ?? []) {
              // A thought summary is the model's working, not its answer.
              if (part.thought !== true) text += part.text ?? '';
            }

            finishReason = candidate?.finishReason ?? finishReason;
            usage = event.usageMetadata ?? usage;
          }
        } catch {
          if (!aborted()) yield PROVIDER_ERROR;
          return;
        }

        if (usage !== undefined) options.onUsage?.(toUsage(usage));

        if (blocked || (finishReason !== undefined && REFUSALS.has(finishReason))) {
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
