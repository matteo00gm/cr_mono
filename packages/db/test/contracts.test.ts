import { describe, expect, it } from 'vitest';

import * as contracts from '../src/contracts.js';
import {
  chatRequest,
  membershipInsert,
  pairingResponse,
  productInsert,
  productUpdate,
  tenantInsert,
  widgetEventInsert,
} from '../src/contracts.js';

/**
 * The derived contracts (P0-42).
 *
 * These run without Docker, which matters: they are the assertions that guard
 * the tenant-id omission, and a guarantee that only holds when someone
 * remembers to start a container is not much of a guarantee.
 */

const validProduct = {
  sku: 'BAROLO-2019',
  name: 'Barolo DOCG 2019',
  wineType: 'RED',
  priceCents: 4200,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
};

describe('productInsert', () => {
  it('accepts a payload with the required fields', () => {
    expect(productInsert.parse(validProduct)).toMatchObject({ sku: 'BAROLO-2019' });
  });

  it('rejects a negative price', () => {
    const result = productInsert.safeParse({ ...validProduct, priceCents: -1 });

    expect(result.success).toBe(false);
  });

  it('rejects a non-integer price, which is how money becomes a float', () => {
    // The column is integer minor units. A contract that accepted 42.5 would
    // push the rounding decision into whatever wrote the row.
    expect(productInsert.safeParse({ ...validProduct, priceCents: 42.5 }).success).toBe(false);
  });

  it('rejects an empty sku', () => {
    expect(productInsert.safeParse({ ...validProduct, sku: '' }).success).toBe(false);
  });

  it('strips tenantId rather than accepting or rejecting it', () => {
    /*
     * The assertion the whole file exists for, and it has to look at the parsed
     * *result* rather than at success. Zod strips unknown keys by default, so a
     * payload carrying tenantId parses happily — the question is whether the
     * value survives. If it did, a client could name the tenant it is writing
     * into.
     */
    const parsed = productInsert.parse({
      ...validProduct,
      tenantId: '00000000-0000-4000-8000-000000000000',
    });

    expect(parsed).not.toHaveProperty('tenantId');
  });

  it('strips the other server-owned columns too', () => {
    const parsed = productInsert.parse({
      ...validProduct,
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('createdAt');
    expect(parsed).not.toHaveProperty('updatedAt');
  });

  it('is in strip mode, not passthrough', () => {
    /*
     * Asserted directly, because every test above would still pass under
     * `.passthrough()` — an unknown key would simply come back, and only a test
     * that names an unknown key notices. This is the switch that silently
     * reverses the guarantee, so it is pinned rather than assumed.
     */
    const parsed = productInsert.parse({ ...validProduct, somethingElse: 'kept?' });

    expect(parsed).not.toHaveProperty('somethingElse');
  });
});

describe('productUpdate', () => {
  it('accepts a partial payload', () => {
    // Inline edit (P1-11) sends one field. A schema requiring the full row
    // would force the client to round-trip a read before every edit.
    expect(productUpdate.safeParse({ priceCents: 3900 }).success).toBe(true);
  });

  it('still refuses an invalid value in the field it was given', () => {
    // Partial must weaken presence, not validation — otherwise the update path
    // becomes the way to write values the insert path rejects.
    expect(productUpdate.safeParse({ priceCents: -1 }).success).toBe(false);
  });

  it('still strips tenantId', () => {
    const parsed = productUpdate.parse({
      priceCents: 3900,
      tenantId: '00000000-0000-4000-8000-000000000000',
    });

    expect(parsed).not.toHaveProperty('tenantId');
  });
});

describe('the other derived contracts', () => {
  it('omits id and timestamps from tenantInsert, which has no tenantId to omit', () => {
    const parsed = tenantInsert.parse({
      name: 'Cantina Rossi',
      slug: 'cantina-rossi',
      id: '22222222-2222-4222-8222-222222222222',
    });

    expect(parsed).not.toHaveProperty('id');
    expect(parsed).toMatchObject({ slug: 'cantina-rossi' });
  });

  it('strips tenantId from membershipInsert', () => {
    const parsed = membershipInsert.parse({
      userId: 'user_2abc',
      role: 'EDITOR',
      tenantId: '00000000-0000-4000-8000-000000000000',
    });

    expect(parsed).not.toHaveProperty('tenantId');
  });

  it('strips tenantId and conversationId from widgetEventInsert', () => {
    // conversationId is resolved server-side from the session, not supplied:
    // a client naming a conversation could attach its events to someone else's.
    const parsed = widgetEventInsert.parse({
      sessionId: 's',
      type: 'WIDGET_OPEN',
      tenantId: '00000000-0000-4000-8000-000000000000',
      conversationId: '33333333-3333-4333-8333-333333333333',
    });

    expect(parsed).not.toHaveProperty('tenantId');
    expect(parsed).not.toHaveProperty('conversationId');
  });
});

describe('the hand-written shapes', () => {
  it('defaults the chat locale to Italian', () => {
    expect(chatRequest.parse({ message: 'Che vino con il brasato?' }).locale).toBe('it');
  });

  it('rejects an empty or oversized chat message', () => {
    expect(chatRequest.safeParse({ message: '' }).success).toBe(false);
    expect(chatRequest.safeParse({ message: 'x'.repeat(2_001) }).success).toBe(false);
  });

  it('requires a uuid for a recommended product, not free text', () => {
    /*
     * P2-25 allowlists recommendations against the retrieved candidates. A
     * schema permitting an arbitrary string would let a hallucinated product
     * reach that check looking plausible, instead of failing to parse — which
     * is the cheaper place to catch it.
     */
    const hallucinated = {
      reply: 'Prova questo.',
      recommendations: [{ productId: 'Barolo 2019', reason: 'strutturato' }],
    };

    expect(pairingResponse.safeParse(hallucinated).success).toBe(false);
  });

  it('caps recommendations at the candidate limit', () => {
    const tooMany = {
      reply: 'ok',
      recommendations: Array.from({ length: 9 }, () => ({
        productId: '44444444-4444-4444-8444-444444444444',
        reason: 'x',
      })),
    };

    expect(pairingResponse.safeParse(tooMany).success).toBe(false);
  });

  it('accepts a well-formed pairing response', () => {
    const valid = {
      reply: 'Un Barolo.',
      recommendations: [
        { productId: '44444444-4444-4444-8444-444444444444', reason: 'strutturato' },
      ],
    };

    expect(pairingResponse.safeParse(valid).success).toBe(true);
  });
});

describe('derivation soundness', () => {
  it('leaves no field as z.any(), which is what a customType derives to', () => {
    /*
     * The guard for the next custom type, not this one.
     *
     * drizzle-zod cannot infer anything about a `customType` and produces
     * `z.any()` for it. That fails open in the worst way: the contract exists,
     * looks derived, and validates nothing — `tenants.slug` (citext) accepted a
     * number until it was given a schema outright. `product_embeddings.embedding`
     * is a customType too, and the next one will be added by someone who has
     * not read this comment.
     */
    const anyFields: string[] = [];

    for (const [name, schema] of Object.entries(contracts)) {
      const shape = (schema as { shape?: Record<string, { constructor: { name: string } }> }).shape;

      if (!shape) continue;

      for (const [field, fieldSchema] of Object.entries(shape)) {
        if (fieldSchema.constructor.name === 'ZodAny') {
          anyFields.push(`${name}.${field}`);
        }
      }
    }

    expect(anyFields).toEqual([]);
  });
});
