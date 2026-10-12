import { randomUUID } from 'node:crypto';
import process from 'node:process';

import {
  ConflictError,
  RateLimitedError,
  SANDBOX_ANSWERS_PER_MINUTE,
  SANDBOX_NOT_SERVED,
  SANDBOX_QUOTA_EXCEEDED,
  type EmbeddingProvider,
  type LlmProvider,
  type PairingChunk,
} from '@catalogorosso/core';
import { createRateLimiter } from '@catalogorosso/db';
import { memoryRateLimiter } from '@catalogorosso/security';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createChatPort, type ProviderFor } from '../src/chat.js';
import { createQuotaPort } from '../src/quota.js';
import { createRagPort, type RagPort } from '../src/rag.js';

/**
 * One real answer in the sandbox, against Postgres (P2-37b, Open Decision 8).
 *
 * **The row's four tests are all about what is written and what is not**, and
 * a fake ledger proves nothing about a ledger: a generated answer is billed
 * once; a winery at its cap is refused with no model call; the limit holds;
 * and the free simulation is still free.
 *
 * Real: the chat port, the monthly gate, the winery's own row, the statements,
 * RLS. Faked, and only to be counted: the model and the embedder.
 */

let harness: TestDatabase | undefined;
let db: TestDatabase['db'];

const DIM = 1024;
const QUESTION = 'qualcosa per una bistecca';

const embeddings: EmbeddingProvider = {
  model: 'amazon.titan-embed-text-v2:0',
  dim: DIM,
  embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: DIM }, () => 0.1))),
};

/** A model that counts its calls, reports its tokens and recommends the wine it is given. */
const counting = (productId?: string) => {
  const calls = { count: 0 };
  const chunks: PairingChunk[] = [
    { type: 'text', delta: 'Con la bistecca, un Barolo.' },
    ...(productId === undefined
      ? []
      : [
          {
            type: 'recommendations' as const,
            items: [{ productId, reason: 'Regge la carne.', confidence: 0.9 }],
          },
        ]),
  ];

  const build: ProviderFor = (onUsage) =>
    ({
      id: 'counted',
      streamPairing: () => {
        calls.count += 1;

        return (async function* () {
          for (const chunk of chunks) yield await Promise.resolve(chunk);

          onUsage({
            inputTokens: 900,
            outputTokens: 60,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
          });
        })();
      },
    }) satisfies LlmProvider;

  return { calls, build };
};

const useTenant = async (id: string): Promise<void> => {
  await db.execute(sql`select set_config('app.tenant_id', ${id}, false)`);
};

/** A winery, paying unless told otherwise — `PENDING_VERIFICATION` is what a new one is. */
const createTenant = async (slug: string, paying = true): Promise<string> => {
  const id = randomUUID();

  await useTenant(id);
  await db.execute(sql`
    insert into tenants (id, name, slug, locale, currency)
    values (${id}::uuid, ${slug}, ${`${slug}-${id}`}, 'it', 'EUR')
  `);

  if (paying) {
    await db.execute(sql`
      update tenants
      set status = 'ACTIVE', plan = 'CANTINA',
          stripe_customer_id = ${`cus_${id}`}, stripe_subscription_id = ${`sub_${id}`}
      where id = ${id}::uuid
    `);
  }

  return id;
};

const addWine = async (id: string): Promise<string> => {
  await useTenant(id);

  const rows = await db.execute(sql`
    insert into products (tenant_id, sku, name, producer, wine_type, price_cents, currency, stock_status)
    values (${id}::uuid, ${`sku-${randomUUID()}`}, 'Barolo Monfortino', 'Giacomo Conterno',
            'red', 2000, 'EUR', 'IN_STOCK')
    returning id
  `);
  const productId = ([...rows][0] as { id: string }).id;

  await db.execute(sql`
    insert into product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model, version)
    values (${id}::uuid, ${productId}::uuid, 0, ${`hash-${productId}`},
            ${JSON.stringify(Array.from({ length: DIM }, () => 0.1))}::halfvec,
            'amazon.titan-embed-text-v2:0', 1)
  `);

  return productId;
};

/** `count` billed turns this month, as the ledger holds them. */
const spend = async (id: string, count: number): Promise<void> => {
  await useTenant(id);
  await db.execute(sql`
    insert into usage_events (tenant_id, period, kind, session_id, cost_micros)
    select ${id}::uuid, to_char(now() at time zone 'utc', 'YYYYMM'), 'chat_message', null, 1
    from generate_series(1, ${count})
  `);
};

interface Written {
  readonly usage: { kind: string; session_id: string | null; cost_micros: string | number }[];
  readonly conversations: number;
  readonly messages: number;
}

/** Everything a turn could have written for one winery. */
const written = async (id: string): Promise<Written> => {
  await useTenant(id);

  const usage = await db.execute(sql`
    select kind, session_id, cost_micros from usage_events where tenant_id = ${id}::uuid
  `);
  const kept = await db.execute(sql`
    select (select count(*)::int from conversations where tenant_id = ${id}::uuid) as conversations,
           (select count(*)::int from messages where tenant_id = ${id}::uuid) as messages
  `);
  const counts = [...kept][0] as { conversations: number; messages: number };

  return { usage: [...usage] as Written['usage'], ...counts };
};

const portWith = (provider: ReturnType<typeof counting>, limiter = memoryRateLimiter()): RagPort =>
  createRagPort({
    provider: embeddings,
    answering: {
      chat: createChatPort({
        embeddings,
        providers: { base: provider.build, strong: provider.build },
        models: { base: 'amazon.nova-lite-v1:0', strong: 'amazon.nova-2-lite-v1:0' },
        quota: createQuotaPort(),
      }),
      limiter,
    },
  });

const ask = (port: RagPort, tenantId: string) =>
  port.answer({ tenantId, query: QUESTION, signal: new AbortController().signal });

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');
  db = harness.db;
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('a generated answer', () => {
  it('is billed once, as one of the winery’s messages, and kept nowhere', async () => {
    const winery = await createTenant('sandbox-billed');
    const neighbour = await createTenant('sandbox-neighbour');
    const wine = await addWine(winery);
    const provider = counting(wine);

    const answer = await ask(portWith(provider), winery);

    expect(answer).toEqual({
      reply: 'Con la bistecca, un Barolo.',
      /* The name is the catalogue's; the model named an id (P2-25). */
      recommendations: [
        { productId: wine, name: 'Barolo Monfortino', reason: 'Regge la carne.', confidence: 0.9 },
      ],
      outcome: 'ok',
    });
    expect(provider.calls.count).toBe(1);

    const after = await written(winery);

    /* One row, the kind the monthly gate counts, under no session, with what the model cost. */
    expect(after.usage).toHaveLength(1);
    expect(after.usage[0]).toMatchObject({ kind: 'chat_message', session_id: null });
    expect(Number(after.usage[0]?.cost_micros)).toBeGreaterThan(0);
    /* Not a conversation: the panels that count questions and wines never see it (P2-37). */
    expect(after.conversations).toBe(0);
    expect(after.messages).toBe(0);
    /* And nobody else's month moved. */
    expect((await written(neighbour)).usage).toEqual([]);
  });

  it('counts against the same month a visitor’s message does', async () => {
    /* Cantina sells 1,500. The 1,500th may be a seller's own; the next is nobody's. */
    const winery = await createTenant('sandbox-edge');

    await addWine(winery);
    await spend(winery, 1_499);

    const last = counting();

    await ask(portWith(last), winery);
    expect(last.calls.count).toBe(1);
    expect((await written(winery)).usage).toHaveLength(1_500);

    const over = counting();

    await expect(ask(portWith(over), winery)).rejects.toThrow(
      new ConflictError(SANDBOX_QUOTA_EXCEEDED),
    );
    expect(over.calls.count).toBe(0);
  });
});

describe('a winery on its trial', () => {
  /** As a first verified domain leaves it (P5-05): trialling, no plan, an end date. */
  const trialling = async (slug: string, endsIn: string): Promise<string> => {
    const id = await createTenant(slug, false);

    await db.execute(sql`
      update tenants
      set status = 'TRIALING', trial_ends_at = now() + ${endsIn}::interval
      where id = ${id}::uuid
    `);
    await addWine(id);

    return id;
  };

  it('is answered while the trial runs, against the trial’s own 150', async () => {
    /* Read from the winery's row: the plan is null, and the gate counts a trial's allowance. */
    const winery = await trialling('sandbox-trial', '3 days');

    await spend(winery, 149);

    const last = counting();

    await ask(portWith(last), winery);
    expect(last.calls.count).toBe(1);

    const over = counting();

    await expect(ask(portWith(over), winery)).rejects.toThrow(
      new ConflictError(SANDBOX_QUOTA_EXCEEDED),
    );
    expect(over.calls.count).toBe(0);
  });

  it('is refused once the trial’s date has passed, with nothing spent', async () => {
    const winery = await trialling('sandbox-trial-over', '-1 minute');
    const provider = counting();

    await expect(ask(portWith(provider), winery)).rejects.toThrow(
      new ConflictError(SANDBOX_NOT_SERVED),
    );
    expect(provider.calls.count).toBe(0);
    expect((await written(winery)).usage).toEqual([]);
  });
});

describe('a winery at its cap', () => {
  it('is refused with no model call, and nothing more on its bill', async () => {
    const winery = await createTenant('sandbox-spent');

    await addWine(winery);
    await spend(winery, 1_500);

    const provider = counting();

    await expect(ask(portWith(provider), winery)).rejects.toThrow(
      new ConflictError(SANDBOX_QUOTA_EXCEEDED),
    );
    expect(provider.calls.count).toBe(0);
    expect((await written(winery)).usage).toHaveLength(1_500);
  });
});

describe('a winery whose widget is not served', () => {
  it('is refused before the gate, the model or the ledger', async () => {
    /* As created: no domain verified, so no trial running and no plan to bill. */
    const winery = await createTenant('sandbox-pending', false);

    await addWine(winery);

    const provider = counting();

    await expect(ask(portWith(provider), winery)).rejects.toThrow(
      new ConflictError(SANDBOX_NOT_SERVED),
    );
    expect(provider.calls.count).toBe(0);
    expect((await written(winery)).usage).toEqual([]);
  });
});

describe('the limit', () => {
  it('holds in Postgres: ten answered and billed in a minute, the eleventh neither', async () => {
    const winery = await createTenant('sandbox-limited');
    const other = await createTenant('sandbox-unlimited');

    await addWine(winery);
    await addWine(other);

    const provider = counting();
    /* The limiter a deployment runs: counted in `rate_limit_buckets`, across every container. */
    const port = portWith(provider, createRateLimiter());

    for (let i = 0; i < SANDBOX_ANSWERS_PER_MINUTE; i += 1) await ask(port, winery);

    await expect(ask(port, winery)).rejects.toBeInstanceOf(RateLimitedError);
    expect(provider.calls.count).toBe(10);
    expect((await written(winery)).usage).toHaveLength(10);

    /* A winery's limit is its own. */
    await expect(ask(port, other)).resolves.toMatchObject({ outcome: 'ok' });
  });
});

describe('off unless asked', () => {
  it('leaves the simulation free: no model call, nothing written, however often it is run', async () => {
    const winery = await createTenant('sandbox-free');

    await addWine(winery);

    const provider = counting();
    const port = portWith(provider);

    for (let i = 0; i < 12; i += 1) {
      const simulation = await port.simulate({ tenantId: winery, query: QUESTION });

      expect(simulation.candidates).toHaveLength(1);
    }

    expect(provider.calls.count).toBe(0);
    expect(await written(winery)).toEqual({ usage: [], conversations: 0, messages: 0 });
  });
});
