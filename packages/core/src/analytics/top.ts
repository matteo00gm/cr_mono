/**
 * What visitors ask, and which wines the sommelier recommends (P6-03, §2.4).
 *
 * **A question is shown only once several conversations have asked it**,
 * because this is a list of what visitors *tend* to ask, and one visitor's
 * phrasing is noise in it. Counted in conversations, not messages, so one
 * visitor asking the same thing five times is still one. (The unanswered
 * questions, P6-04, are the opposite list — every one counts there — and
 * contact details never reach either: they are removed before a question is
 * stored, P2-33.)
 *
 * **Normalised by the store, lowercased and with its whitespace collapsed**:
 * *"Un rosso  per la bistecca"* and *"un rosso per la bistecca "* are one
 * question. Nothing cleverer — stemming, synonyms — because a seller reads
 * these as what people typed, and a normaliser that merged two questions they
 * would have told apart is one they would stop trusting.
 */

/** The fewest conversations a question needs before it is shown. */
export const MIN_QUERY_CONVERSATIONS = 3;

/** How many questions and how many wines a panel lists. */
export const TOP_LIMIT = 10;
