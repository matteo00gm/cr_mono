import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Recommendation } from '../../src/rag/llm-provider.js';
import {
  MAX_REASON_CHARACTERS,
  MAX_RECOMMENDATIONS,
  MAX_REPLY_CHARACTERS,
  pairingJsonSchema,
  pairingOutput,
  parsePairingOutput,
  type PairingOutput,
} from '../../src/rag/pairing-schema.js';

/**
 * The structured-output schema (P2-24).
 *
 * The row's tests — a valid answer parses, an over-long reason and a fifth card
 * are refused, the generated JSON Schema is pinned — plus the caps every other
 * field carries, and the agreement with P1-41's `Recommendation` that keeps the
 * port and the schema from describing two different answers.
 */

const PRODUCT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const recommendation = (over: Record<string, unknown> = {}) => ({
  productId: PRODUCT,
  reason: 'Tannini fitti per la carne brasata.',
  confidence: 0.8,
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  reply: 'Con il brasato scelgo un rosso strutturato.',
  recommendations: [recommendation()],
  ...over,
});

const refused = (value: unknown): readonly string[] => {
  const result = parsePairingOutput(value);
  if (result.ok) throw new Error('expected the answer to be refused');
  return result.issues;
};

describe('parsePairingOutput', () => {
  it('accepts a valid answer, and one that recommends nothing', () => {
    expect(parsePairingOutput(answer())).toEqual({ ok: true, value: answer() });
    expect(parsePairingOutput(answer({ recommendations: [] })).ok).toBe(true);
  });

  it('pins the caps', () => {
    expect([MAX_REPLY_CHARACTERS, MAX_REASON_CHARACTERS, MAX_RECOMMENDATIONS]).toEqual([
      1200, 240, 4,
    ]);
  });

  it('refuses a reason one character over the cap, and accepts one at it', () => {
    expect(
      parsePairingOutput(answer({ recommendations: [recommendation({ reason: 'x'.repeat(240) })] }))
        .ok,
    ).toBe(true);
    expect(
      refused(answer({ recommendations: [recommendation({ reason: 'x'.repeat(241) })] })),
    ).toEqual([expect.stringMatching(/^recommendations\.0\.reason: /)]);
  });

  it('refuses an empty reason', () => {
    expect(refused(answer({ recommendations: [recommendation({ reason: '' })] }))).toHaveLength(1);
  });

  it('refuses a fifth recommendation', () => {
    const four = Array.from({ length: 4 }, () => recommendation());

    expect(parsePairingOutput(answer({ recommendations: four })).ok).toBe(true);
    expect(refused(answer({ recommendations: [...four, recommendation()] }))).toEqual([
      expect.stringMatching(/^recommendations: /),
    ]);
  });

  it('refuses a reply over the cap', () => {
    expect(parsePairingOutput(answer({ reply: 'x'.repeat(1200) })).ok).toBe(true);
    expect(refused(answer({ reply: 'x'.repeat(1201) }))).toHaveLength(1);
  });

  it('refuses a product id that could not be a candidate', () => {
    expect(
      refused(answer({ recommendations: [recommendation({ productId: 'BAR-2019' })] })),
    ).toEqual([expect.stringMatching(/^recommendations\.0\.productId: /)]);
  });

  it.each([-0.1, 1.1])('refuses a confidence of %s', (confidence) => {
    expect(refused(answer({ recommendations: [recommendation({ confidence })] }))).toHaveLength(1);
  });

  it('refuses a missing reply, and something that is not an answer at all', () => {
    expect(refused({ recommendations: [] })).toEqual([expect.stringMatching(/^reply: /)]);
    // A root issue carries no path, so it is Zod's own message with nothing prefixed.
    expect(refused('not an object')).toEqual([
      pairingOutput.safeParse('not an object').error?.issues[0]?.message,
    ]);
  });

  it('strips an unknown key rather than refusing a valid answer over it', () => {
    const parsed = parsePairingOutput(answer({ mood: 'allegro' }));

    expect(parsed).toEqual({ ok: true, value: answer() });
  });
});

describe('pairingJsonSchema', () => {
  const schema = pairingJsonSchema() as {
    $schema?: unknown;
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: {
      reply: { maxLength: number };
      recommendations: {
        maxItems: number;
        items: {
          required: string[];
          additionalProperties: boolean;
          properties: {
            productId: { format: string };
            reason: { minLength: number; maxLength: number };
            confidence: { minimum: number; maximum: number };
          };
        };
      };
    };
  };

  it('carries every cap the Zod schema does, so no provider sees a looser answer', () => {
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['reply', 'recommendations']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.reply.maxLength).toBe(1200);
    expect(schema.properties.recommendations.maxItems).toBe(4);

    const item = schema.properties.recommendations.items;
    expect(item.required).toEqual(['productId', 'reason', 'confidence']);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.productId.format).toBe('uuid');
    expect(item.properties.reason).toMatchObject({ minLength: 1, maxLength: 240 });
    expect(item.properties.confidence).toMatchObject({ minimum: 0, maximum: 1 });
  });

  it('leaves out the dialect key, which describes the document rather than the answer', () => {
    expect(schema).not.toHaveProperty('$schema');
  });

  it('is built fresh each call, so an adapter that edits its copy changes no other', () => {
    const first = pairingJsonSchema();
    first.type = 'string';

    expect(pairingJsonSchema().type).toBe('object');
  });
});

describe('the schema and the port', () => {
  it('describe the same recommendation', () => {
    // P1-41's `Recommendation` is what flows through the stream; this is what
    // validates it. If they drifted, a valid answer could fail to typecheck as a chunk.
    expectTypeOf<keyof PairingOutput['recommendations'][number]>().toEqualTypeOf<
      keyof Recommendation
    >();
    expectTypeOf<PairingOutput['recommendations'][number]>().toExtend<Recommendation>();
  });
});
