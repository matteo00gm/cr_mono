import { sql } from 'drizzle-orm';

import { normalisedQuestion } from './top.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * The questions the catalogue could not answer (P6-04, §2.4), read in the
 * scope's tenant: every answer that showed no wine (`zero_result_kind`, set
 * when the turn was recorded), paired with the question it answered.
 *
 * **The question is the one just before the answer**, by `seq` in the same
 * conversation: a turn inserts both in one statement, question first (P2-30),
 * so that is the question this answer was to.
 *
 * **Every question, not the top few.** The themes above the list count
 * conversations across all of them, and a theme counted from a truncated list
 * would undercount exactly the long tail this panel is for. Each row carries
 * its conversations so a theme can count a conversation once however many of
 * its questions use the theme's words.
 */

export interface ZeroResultsQuery {
  readonly start: Date;
  /** The first instant not counted: the range is `[start, end)`. */
  readonly end: Date;
}

export interface UnansweredQuestion {
  /** Normalised as P6-03's are. */
  readonly question: string;
  /** The conversations that asked it and were shown no wine. */
  readonly conversationIds: readonly string[];
  /** Of those, the ones where no candidate used the question's words. */
  readonly noMatch: number;
  /** And the ones where some did, and none was recommended. */
  readonly notRecommended: number;
  readonly lastAskedAt: Date;
}

export const readZeroResults = async (
  tx: DbTransaction,
  { start, end }: ZeroResultsQuery,
): Promise<UnansweredQuestion[]> => {
  const rows = await tx.execute(sql`
    with answered as (
      select
        a.conversation_id,
        a.zero_result_kind,
        a.created_at,
        (
          select q.content from messages q
          where q.conversation_id = a.conversation_id
            and q.role = 'USER'
            and q.seq < a.seq
          order by q.seq desc
          limit 1
        ) as question
      from messages a
      where a.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and a.role = 'ASSISTANT'
        and a.zero_result_kind is not null
        and a.created_at >= ${start.toISOString()}::timestamptz
        and a.created_at < ${end.toISOString()}::timestamptz
    )
    select
      ${normalisedQuestion(sql`question`)} as question,
      array_agg(distinct conversation_id) as conversation_ids,
      count(distinct conversation_id) filter (where zero_result_kind = 'no_match')::int as no_match,
      count(distinct conversation_id) filter (where zero_result_kind = 'not_recommended')::int
        as not_recommended,
      max(created_at) as last_asked_at
    from answered
    where question is not null
    group by 1
    order by count(distinct conversation_id) desc, max(created_at) desc, 1
  `);

  return [...rows].map((row) => ({
    question: String(row.question),
    conversationIds: (row.conversation_ids as string[]).map(String),
    noMatch: Number(row.no_match),
    notRecommended: Number(row.not_recommended),
    lastAskedAt: new Date(row.last_asked_at as string | Date),
  }));
};
