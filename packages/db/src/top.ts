import { sql, type SQL } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * What visitors ask, and which wines are recommended (P6-03, §2.4), read in
 * the scope's tenant. Repository functions, for P6-02's reason: what they read
 * can become an aggregate without anything above them knowing.
 */

export interface TopQueriesQuery {
  readonly start: Date;
  /** The first instant not counted: the range is `[start, end)`. */
  readonly end: Date;
  /** The fewest conversations a question needs to be listed (core's `MIN_QUERY_CONVERSATIONS`). */
  readonly minConversations: number;
  readonly limit: number;
}

export interface TopQuery {
  /** Lowercased, trimmed, its whitespace collapsed. */
  readonly query: string;
  /** Conversations that asked it: one visitor asking five times is one. */
  readonly conversations: number;
  readonly lastAskedAt: Date;
}

/**
 * A visitor's question as the panels group it: lowercased, trimmed, its
 * whitespace collapsed. One definition, for P6-03's list and P6-04's.
 *
 * `[[:space:]]` rather than `\s`, which a template literal would turn into a
 * plain `s` before Postgres ever saw it.
 */
export const normalisedQuestion = (column: SQL): SQL =>
  sql`lower(btrim(regexp_replace(${column}, '[[:space:]]+', ' ', 'g')))`;

/** The questions most conversations asked, normalised and grouped. */
export const readTopQueries = async (
  tx: DbTransaction,
  { start, end, minConversations, limit }: TopQueriesQuery,
): Promise<TopQuery[]> => {
  const rows = await tx.execute(sql`
    select
      ${normalisedQuestion(sql`m.content`)} as query,
      count(distinct m.conversation_id)::int as conversations,
      max(m.created_at) as last_asked_at
    from messages m
    where m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and m.role = 'USER'
      and m.created_at >= ${start.toISOString()}::timestamptz
      and m.created_at < ${end.toISOString()}::timestamptz
    group by 1
    having count(distinct m.conversation_id) >= ${minConversations}::int
    order by 2 desc, 3 desc, 1
    limit ${limit}::int
  `);

  return [...rows].map((row) => ({
    query: String(row.query),
    conversations: Number(row.conversations),
    lastAskedAt: new Date(row.last_asked_at as string | Date),
  }));
};

export interface TopProductsQuery {
  readonly start: Date;
  readonly end: Date;
  readonly limit: number;
}

export interface TopProduct {
  readonly productId: string;
  /** `null` for a wine no longer in the catalogue: the recommendation still happened. */
  readonly name: string | null;
  readonly archived: boolean;
  /** Conversations it was shown in, as a card. */
  readonly recommended: number;
  /** Of those, the ones that added it to the cart. Never more than `recommended`. */
  readonly added: number;
}

/**
 * The wines shown most, with the conversations that went on to add each one.
 *
 * **Shown is the cards** (`recommended_product_ids`), not the candidates the
 * model was given. **An add counts only in a conversation that was shown the
 * wine**, joined on both, so the share can be read as a conversion and is
 * never over one. **A wine since removed keeps its row**: the join to
 * `products` is a left join, and a recommendation that happened is not undone
 * by the catalogue changing afterwards.
 */
export const readTopProducts = async (
  tx: DbTransaction,
  { start, end, limit }: TopProductsQuery,
): Promise<TopProduct[]> => {
  const rows = await tx.execute(sql`
    with shown as (
      select distinct m.conversation_id, r.product_id
      from messages m
      cross join lateral unnest(m.recommended_product_ids) as r(product_id)
      where m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and m.role = 'ASSISTANT'
        and m.created_at >= ${start.toISOString()}::timestamptz
        and m.created_at < ${end.toISOString()}::timestamptz
    ),
    carted as (
      select distinct e.conversation_id, e.product_id
      from widget_events e
      where e.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and e.type = 'ADD_TO_CART'
        and e.created_at >= ${start.toISOString()}::timestamptz
        and e.created_at < ${end.toISOString()}::timestamptz
    )
    select
      s.product_id,
      p.name,
      coalesce(p.status = 'ARCHIVED', false) as archived,
      count(*)::int as recommended,
      count(c.conversation_id)::int as added
    from shown s
    left join carted c on c.conversation_id = s.conversation_id and c.product_id = s.product_id
    left join products p on p.id = s.product_id
    group by s.product_id, p.name, p.status
    order by recommended desc, added desc, s.product_id
    limit ${limit}::int
  `);

  return [...rows].map((row) => ({
    productId: String(row.product_id),
    name: typeof row.name === 'string' ? row.name : null,
    archived: row.archived === true,
    recommended: Number(row.recommended),
    added: Number(row.added),
  }));
};
