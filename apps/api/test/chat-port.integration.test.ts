import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type {
  EmbeddingProvider,
  LlmProvider,
  PairingChunk,
  Recommendation,
} from '@catalogorosso/core';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createChatPort, QuotaExceededError, type ChatPort, type TurnReport } from '../src/chat.js';
import { createQuotaPort } from '../src/quota.js';
import type { WidgetTenant } from '../src/env.js';

/**
 * Answering a question, end to end against Postgres (P2-29).
 *
 * **The three assertions here are the ones the row calls security-relevant**,
 * and none of them can be made anywhere else: the quota refuses *before* a
 * provider is touched, a card the model invented never reaches the caller, and
 * the turn is recorded with its bill when the stream ends however it ended.
 *
 * Only the two providers are faked, and they are faked to be *counted* — the
 * whole point of "zero provider calls" is a number, and a real provider would
 * make it a bill.
 */

let harness: TestDatabase | undefined;
let db: TestDatabase['db'];
let tenantId: string;

const DIM = 1024;

const tenant = (id: string): WidgetTenant => ({
  tenantId: id,
  plan: 'CANTINA',
  status: 'ACTIVE',
  locale: 'it',
});

const embeddings: EmbeddingProvider = {
  model: 'amazon.titan-embed-text-v2:0',
  dim: DIM,
  embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: DIM }, () => 0.1))),
};

/** A provider that counts its calls and answers with exactly these chunks. */
const counting = (...chunks: readonly PairingChunk[]) => {
  const calls = { count: 0 };
  const build = (): LlmProvider => ({
    id: 'counted',
    streamPairing: () => {
      calls.count += 1;

      return (async function* () {
        for (const chunk of chunks) yield await Promise.resolve(chunk);
      })();
    },
  });

  return { calls, build };
};

const useTenant = async (id: string): Promise<void> => {
  await db.execute(sql`select set_config('app.tenant_id', ${id}, false)`);
};

const createTenant = async (slug: string): Promise<string> => {
  const id = randomUUID();

  await useTenant(id);
  await db.execute(sql`
    insert into tenants (id, name, slug, locale, currency)
    values (${id}::uuid, ${slug}, ${`${slug}-${id}`}, 'it', 'EUR')
  `);

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

const portWith = (provider: ReturnType<typeof counting>): ChatPort =>
  createChatPort({
    embeddings,
    providers: { base: () => provider.build(), strong: () => provider.build() },
    models: { base: 'amazon.nova-lite-v1:0', strong: 'amazon.nova-2-lite-v1:0' },
    quota: createQuotaPort(),
  });

const ask = async (
  port: ChatPort,
  id: string,
  sessionId = `sess-${randomUUID()}`,
): Promise<{ chunks: PairingChunk[]; report: TurnReport | undefined }> => {
  const chunks: PairingChunk[] = [];
  let report: TurnReport | undefined;

  for await (const chunk of port.answer(
    {
      tenant: tenant(id),
      sessionId,
      origin: 'https://cantina-rossi.example',
      visitorHash: null,
      message: 'qualcosa per una bistecca',
      signal: new AbortController().signal,
    },
    (reported) => {
      report = reported;
    },
  )) {
    chunks.push(chunk);
  }

  return { chunks, report };
};

const cardsIn = (chunks: readonly PairingChunk[]): readonly Recommendation[] =>
  chunks.flatMap((chunk) => (chunk.type === 'recommendations' ? [...chunk.items] : []));

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');
  db = harness.db;

  tenantId = await createTenant('chat');
  await addWine(tenantId);
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('the cost gate', () => {
  it('refuses a spent month having made zero provider calls', async () => {
    /*
     * **The row's own test, and the reason the quota is checked where it is.**
     * A gate after retrieval has paid for a query; a gate after generation has
     * paid for the answer. Counting the provider is the only way to say which
     * one this is.
     */
    const spent = await createTenant('chat-spent');
    const provider = counting({ type: 'text', delta: 'ciao' });

    await useTenant(spent);
    await db.execute(sql`
      insert into usage_events (tenant_id, period, kind, session_id, cost_micros)
      select ${spent}::uuid, to_char(now() at time zone 'utc', 'YYYYMM'), 'chat_message', null, 1
      from generate_series(1, 1500)
    `);

    await expect(ask(portWith(provider), spent)).rejects.toThrow(QuotaExceededError);
    expect(provider.calls.count).toBe(0);
  });

  it('answers a tenant with room left', async () => {
    const provider = counting({ type: 'text', delta: 'Un Barolo.' });

    const { chunks } = await ask(portWith(provider), tenantId);

    expect(provider.calls.count).toBe(1);
    expect(chunks).toContainEqual({ type: 'text', delta: 'Un Barolo.' });
  });
});

describe('what the model is allowed to name', () => {
  it('drops a wine this request never retrieved, so no card reaches the caller', async () => {
    /*
     * P2-26's case, at the layer that answers a visitor rather than at the
     * stream. The id is a well-formed UUID and belongs to nobody — exactly what
     * an injected tasting note asks a model to produce (P2-32).
     */
    const invented = randomUUID();
    const provider = counting(
      { type: 'text', delta: 'Le consiglio questa.' },
      {
        type: 'recommendations',
        items: [{ productId: invented, reason: 'perché sì', confidence: 0.9 }],
      },
    );

    const { chunks, report } = await ask(portWith(provider), tenantId);

    expect(cardsIn(chunks)).toEqual([]);
    expect(report?.dropped).toEqual([invented]);
  });

  it('keeps a wine it did retrieve', async () => {
    const kept = await createTenant('chat-kept');
    const productId = await addWine(kept);
    const provider = counting({
      type: 'recommendations',
      items: [{ productId, reason: 'tannino per il grasso', confidence: 0.9 }],
    });

    const { chunks } = await ask(portWith(provider), kept);

    expect(cardsIn(chunks).map((card) => card.productId)).toEqual([productId]);
  });
});

describe('what a turn leaves behind', () => {
  it('records the question, the reply and the bill in one write', async () => {
    const recorded = await createTenant('chat-recorded');

    await addWine(recorded);

    const session = `sess-${randomUUID()}`;
    const provider = counting({ type: 'text', delta: 'Un Barolo.' });

    await ask(portWith(provider), recorded, session);
    await useTenant(recorded);

    const messages = [
      ...(await db.execute(sql`
        select m.role, m.content from messages m
        join conversations c on c.id = m.conversation_id
        where c.session_id = ${session}
        order by m.created_at, m.role
      `)),
    ] as { role: string; content: string }[];

    const billed = [
      ...(await db.execute(sql`
        select count(*)::int as n from usage_events
        where tenant_id = ${recorded}::uuid and session_id = ${session}
      `)),
    ][0] as { n: number };

    const shown = [
      ...(await db.execute(sql`
        select m.retrieved_product_ids from messages m
        join conversations c on c.id = m.conversation_id
        where c.session_id = ${session} and m.role = 'ASSISTANT'
      `)),
    ][0] as { retrieved_product_ids: string[] | null };

    expect(messages).toEqual([
      { role: 'USER', content: 'qualcosa per una bistecca' },
      { role: 'ASSISTANT', content: 'Un Barolo.' },
    ]);
    expect(billed.n).toBe(1);

    /*
     * The wines the model was *shown*, which is what a complaint asks about.
     * An empty list here would make every past recommendation unauditable, and
     * nothing about the row would look wrong.
     */
    expect(shown.retrieved_product_ids).toHaveLength(1);
  });

  it('records a turn the provider abandoned part way', async () => {
    /*
     * A visitor who closes the tab still has what was generated recorded,
     * because what was generated was paid for. The `finally` is what makes that
     * true of a failure as well as of a clean finish.
     */
    const aborted = await createTenant('chat-aborted');

    await addWine(aborted);

    const session = `sess-${randomUUID()}`;
    const failing: LlmProvider = {
      id: 'failing',
      streamPairing: () =>
        (async function* () {
          yield await Promise.resolve<PairingChunk>({ type: 'text', delta: 'Un ' });
          throw new Error('the visitor closed the tab');
        })(),
    };

    const port = createChatPort({
      embeddings,
      providers: { base: () => failing, strong: () => failing },
      models: { base: 'amazon.nova-lite-v1:0', strong: 'amazon.nova-2-lite-v1:0' },
      quota: createQuotaPort(),
    });

    await expect(ask(port, aborted, session)).rejects.toThrow('closed the tab');
    await useTenant(aborted);

    const kept = [
      ...(await db.execute(sql`
        select m.content from messages m
        join conversations c on c.id = m.conversation_id
        where c.session_id = ${session} and m.role = 'ASSISTANT'
      `)),
    ][0] as { content: string } | undefined;

    expect(kept?.content).toBe('Un ');
  });

  it('remembers the conversation for the next question', async () => {
    // P2-35 caps how much history reaches the prompt; this is what there is to
    // cap. Without it a follow-up is answered by a model that never saw the
    // question it is following up.
    const remembering = await createTenant('chat-memory');

    await addWine(remembering);

    const session = `sess-${randomUUID()}`;
    const provider = counting({ type: 'text', delta: 'Un Barolo.' });
    const port = portWith(provider);

    await ask(port, remembering, session);
    await ask(port, remembering, session);
    await useTenant(remembering);

    const turns = [
      ...(await db.execute(sql`
        select count(*)::int as n from messages m
        join conversations c on c.id = m.conversation_id
        where c.session_id = ${session}
      `)),
    ][0] as { n: number };

    expect(turns.n).toBe(4);
  });
});
