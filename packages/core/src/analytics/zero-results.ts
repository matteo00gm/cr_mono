import type { ZeroResultKind } from '@catalogorosso/db';

import type { PairingOutcome } from '../rag/repair.js';

/**
 * The questions the catalogue could not answer (P6-04, §2.4) — the panel that
 * tells a seller what to stock.
 *
 * **Two kinds, told apart by what reached the model.** *No match*: none of
 * the candidates was found by the words of the question — by the lexical
 * branch's own test (P2-19): every word of it, or a close spelling — so what
 * reached the model was only its nearest neighbours in meaning. *Not recommended*: wines that use those words did
 * reach the model, and it judged none of them right. The first is a gap in
 * the catalogue; the second is a catalogue that has the word but not the
 * wine. Different fixes, so different columns.
 *
 * Not P2-22's pre-cap count, which the row names: the vector branch returns
 * nearest neighbours whatever was asked, and the chat applies no price
 * ceiling, so that count is zero only for an empty catalogue — it would put
 * every unanswered question in the second kind.
 *
 * **And the pattern above the list.** *"14 visitatori hanno chiesto vini
 * dolci"* is what a seller acts on; forty phrasings of it are what they scroll
 * past. A question belongs to every theme whose words it uses, matched as
 * whole words, in Italian and in English, because those are the two
 * languages a winery's visitors write in most. Deliberately a word list, not
 * a model: a seller can read why a question landed where it did, and a theme
 * nobody can explain is one nobody acts on.
 */

export { ZERO_RESULT_KINDS, type ZeroResultKind } from '@catalogorosso/db';

/**
 * How many questions the panel lists. The themes count every question; the
 * list is what a seller reads, and what the export writes.
 */
export const ZERO_RESULTS_LIMIT = 100;

/**
 * Why an answer showed no wine, or `null` when it showed one.
 *
 * `null` too for an answer that failed rather than answered — the provider
 * raised, the schema could not be met, the model declined — because none of
 * those is a gap in the catalogue, and each is reported where it happened.
 * Otherwise: `no_match` when no candidate was found by the words of the
 * question (or there were none), `not_recommended` when some were and the
 * model chose none of them.
 */
export const zeroResultOf = ({
  outcome,
  cards,
  wordMatches,
}: {
  readonly outcome: PairingOutcome;
  /** Cards sent to the visitor. */
  readonly cards: number;
  /** Candidates that reached the model and were found by the question's words: the lexical branch's (P2-19). */
  readonly wordMatches: number;
}): ZeroResultKind | null => {
  if (cards > 0) return null;
  if (outcome !== 'ok' && outcome !== 'repaired') return null;

  return wordMatches === 0 ? 'no_match' : 'not_recommended';
};

export interface Theme {
  readonly id: string;
  /** As it reads after *"N visitatori hanno chiesto"*. */
  readonly label: string;
  /** Whole words or phrases, lowercased. */
  readonly words: readonly string[];
}

export const THEMES: readonly Theme[] = [
  {
    id: 'sweet',
    label: 'vini dolci',
    words: [
      'dolce',
      'dolci',
      'passito',
      'passiti',
      'moscato',
      'vin santo',
      'vinsanto',
      'sweet',
      'dessert wine',
    ],
  },
  {
    id: 'sparkling',
    label: 'bollicine',
    words: [
      'bollicine',
      'spumante',
      'spumanti',
      'frizzante',
      'frizzanti',
      'prosecco',
      'franciacorta',
      'metodo classico',
      'champagne',
      'sparkling',
      'bubbles',
    ],
  },
  { id: 'rose', label: 'vini rosati', words: ['rosato', 'rosati', 'rosé', 'rosè', 'rose wine'] },
  {
    id: 'organic',
    label: 'vini biologici o naturali',
    words: [
      'biologico',
      'biologici',
      'bio',
      'naturale',
      'naturali',
      'biodinamico',
      'biodinamici',
      'organic',
      'natural wine',
    ],
  },
  { id: 'sulphites', label: 'vini senza solfiti', words: ['solfiti', 'sulfites', 'sulphites'] },
  { id: 'vegan', label: 'vini vegani', words: ['vegano', 'vegani', 'vegan'] },
  {
    id: 'alcohol-free',
    label: 'vini analcolici',
    words: [
      'analcolico',
      'analcolici',
      'dealcolato',
      'dealcolati',
      'senza alcol',
      'alcohol free',
      'non alcoholic',
    ],
  },
  {
    id: 'budget',
    label: 'vini economici',
    words: ['economico', 'economici', 'poco prezzo', 'costa poco', 'cheap', 'budget', 'affordable'],
  },
  { id: 'gift', label: 'idee regalo', words: ['regalo', 'regali', 'regalare', 'gift'] },
  { id: 'large-format', label: 'grandi formati', words: ['magnum', 'grande formato', 'jeroboam'] },
  { id: 'red', label: 'vini rossi', words: ['rosso', 'rossi', 'red'] },
  { id: 'white', label: 'vini bianchi', words: ['bianco', 'bianchi', 'white'] },
];

/** The words of a text, lowercased, apostrophes and punctuation as spaces: `"Un po' di rosé!"` → `un po di rosé`. */
const wordsOf = (text: string): string =>
  ` ${text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
    .join(' ')} `;

/** The themes a question belongs to, in `THEMES` order. Whole words only: `bio` is not `biondo`. */
export const themesOf = (question: string): Theme[] => {
  const words = wordsOf(question);

  return THEMES.filter((theme) => theme.words.some((word) => words.includes(` ${word} `)));
};
