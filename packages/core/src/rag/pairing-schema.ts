import { z } from 'zod';

/**
 * What a model must return for a pairing (P2-24, §4.5).
 *
 * **One Zod schema, and every provider's format is derived from it.** Bedrock's
 * tool input schema, Gemini's `responseSchema` and Anthropic's output format are
 * three projections of this object, so a cap changed here cannot stay unchanged
 * in one of them. Each adapter converts `pairingJsonSchema()` for its provider;
 * none of them writes a schema of its own.
 *
 * Structured output is a security requirement rather than a convenience: P2-25's
 * allowlist can only drop a hallucinated or cross-tenant product if the answer
 * parses into ids it can check.
 */

/** The visible reply. Long enough for a sommelier's paragraph, short enough to read in a widget. */
export const MAX_REPLY_CHARACTERS = 1200;

/**
 * The reason shown under a recommended wine.
 *
 * **This cap is a security control as well as a layout one** (P2-23). `reason`
 * is free text the allowlist cannot check, so it is the one place a model could
 * leak its instructions to a visitor, and 240 characters is too little to leak
 * a system prompt in any useful form. A change to "allow longer explanations"
 * would remove that control while looking like a UX improvement.
 */
export const MAX_REASON_CHARACTERS = 240;

/** Cards per answer. More is a list, not a recommendation, and every card is prompt and render cost. */
export const MAX_RECOMMENDATIONS = 4;

/**
 * The pairing schema.
 *
 * Unknown keys are **stripped, not refused** — Zod's default, kept on purpose.
 * The JSON Schema already forbids them for providers that enforce it, and
 * refusing an otherwise valid answer over an extra key would count as a schema
 * failure: the rate P1-47 disqualifies a model on, for nothing a visitor sees.
 */
export const pairingOutput = z.object({
  reply: z.string().max(MAX_REPLY_CHARACTERS),
  recommendations: z
    .array(
      z.object({
        /** Every product id is a UUID; anything else cannot be a candidate, so it is refused here. */
        productId: z.uuid(),
        /** At least one character: a card with an empty reason tells the visitor nothing. */
        reason: z.string().min(1).max(MAX_REASON_CHARACTERS),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(MAX_RECOMMENDATIONS),
});

export type PairingOutput = z.infer<typeof pairingOutput>;

/**
 * The schema as JSON Schema, for a provider's structured-output mechanism.
 *
 * Draft 2020-12, as Zod 4 emits it, with the `$schema` dialect key removed: it
 * describes the document rather than constraining the answer, and a provider
 * that validates the keys it accepts refuses a request carrying it.
 */
export const pairingJsonSchema = (): Record<string, unknown> => {
  const schema = { ...z.toJSONSchema(pairingOutput) } as Record<string, unknown>;
  delete schema.$schema;
  return schema;
};

export type PairingParse =
  | { readonly ok: true; readonly value: PairingOutput }
  | {
      readonly ok: false;
      /** `path: message`, one per problem — what P2-27's repair prompt shows the model. */
      readonly issues: readonly string[];
    };

/**
 * Validates a model's structured output.
 *
 * Returns rather than throws, because a failure is an expected outcome with a
 * next step (P1-41): the adapter emits `schema_invalid`, and P2-27 retries once
 * with these issues in the repair prompt.
 */
export const parsePairingOutput = (value: unknown): PairingParse => {
  const parsed = pairingOutput.safeParse(value);

  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    }),
  };
};
