/**
 * What visitors ask, and which wines the sommelier recommends (P6-03, §2.4).
 *
 * **A question is shown only once several conversations have asked it.** One
 * visitor's phrasing is noise, and it is also the one place a visitor's own
 * words reach the seller: a name or an address typed into the chat is asked
 * once, by one person, and the threshold keeps it off the screen. Counted in
 * conversations, not messages, so one visitor asking the same thing five
 * times is still one.
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
