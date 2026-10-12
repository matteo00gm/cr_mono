/**
 * Reading the refusals out of the source, and telling which language one is in (P6-12).
 *
 * A `DomainError`'s message reaches the caller verbatim (P0-55), and the
 * dashboard prints it. So the words are the contract, and the only complete
 * list of them is the source: a route test meets the refusals somebody thought
 * to provoke, and the one written last week in English is not among them.
 *
 * **Not a parser.** It finds `new SomethingError(` and reads the first
 * argument far enough to separate what is written there — string and template
 * literals — from what is only named there: a constant, a function call. A
 * name is followed to its `const` in the same file, and one that is not there
 * is handed back to the caller, who has to produce the words some other way.
 * Nothing is ever skipped quietly; that is the property the guard rests on.
 */

export type Language = 'italian' | 'english' | 'neither';

/** Words an Italian sentence does not contain. Deliberately none Italian shares: no `a`, `in`, `no`, `come`, `per`. */
const ENGLISH: ReadonlySet<string> = new Set(
  (
    'the is are was were this that these those you your with cannot must not of for and to be ' +
    'been has have already please send try again which from there their only can will it an ' +
    'on at by or if than when what'
  ).split(' '),
);

/** Words an English sentence does not contain. No single letters: `a`, `e`, `i` and `o` prove nothing. */
const ITALIAN: ReadonlySet<string> = new Set(
  (
    'il lo la gli le un una uno di del dello della dei degli delle dal dalla per non che con ' +
    'questo questa questi queste tuo tua tuoi hai è sono più già ancora fra tra nel nella nello ' +
    'al alla ai oppure quindi prima poi può deve'
  ).split(' '),
);

/**
 * What is quoted is not prose: a parameter's name, a body's shape, a SKU the
 * caller sent. `«from»` in an Italian sentence does not make it English — and
 * neither does `cantina.it`, whose last two letters are an English word: a name
 * with a dot inside it is an address, not a sentence.
 */
const NOT_PROSE = /«[^»]*»|"[^"]*"|\S+\.\S+/gu;

const wordsOf = (text: string): string[] =>
  text
    .replaceAll(NOT_PROSE, ' ')
    .toLowerCase()
    .match(/\p{L}+/gu) ?? [];

/** The English words in a sentence: what a failure should quote. */
export const englishIn = (text: string): string[] => wordsOf(text).filter((w) => ENGLISH.has(w));

/**
 * Italian has an Italian word and no English one; English has an English one.
 *
 * `neither` is its own answer rather than a guess: "Invalid code" has no word
 * from either list, and a guard that waved it through as Italian would be the
 * guard not working.
 */
export const languageOf = (text: string): Language => {
  const words = wordsOf(text);

  if (words.some((word) => ENGLISH.has(word))) return 'english';

  return words.some((word) => ITALIAN.has(word)) ? 'italian' : 'neither';
};

export interface Refusal {
  readonly line: number;
  /** The class constructed: `ConflictError`. */
  readonly error: string;
  /** No message given, so the caller reads the class's own default. */
  readonly bare: boolean;
  /** Every literal part of the message, in order, joined by spaces. */
  readonly written: string;
  /** What the message names rather than writes, and this file does not define. */
  readonly named: readonly string[];
}

interface Read {
  readonly written: string[];
  readonly named: string[];
  readonly end: number;
}

const IDENTIFIER_START = /[A-Za-z_$]/u;
const IDENTIFIER_PART = /[\w$.]/u;

/** The index just past the bracket that closes the one at `from`, strings and all. */
const pastClosing = (source: string, from: number): number => {
  let depth = 0;
  let at = from;

  while (at < source.length) {
    const ch = source.charAt(at);

    if (ch === "'" || ch === '"' || ch === '`') {
      at = readLiteral(source, at, true).end;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;

    at += 1;

    if (depth === 0) return at;
  }

  return at;
};

/** A string or a template starting at `from`: its text, and for a template whatever its `${}` holds. */
function readLiteral(source: string, from: number, everything: boolean): Read {
  const quote = source.charAt(from);
  const written: string[] = [];
  const named: string[] = [];
  let text = '';
  let at = from + 1;

  while (at < source.length) {
    const ch = source.charAt(at);

    if (ch === '\\') {
      text += source.charAt(at + 1);
      at += 2;
      continue;
    }

    if (ch === quote) {
      at += 1;
      break;
    }

    if (quote === '`' && ch === '$' && source.charAt(at + 1) === '{') {
      /*
       * Inside `${}` every literal is message text — `cap === 1 ? 'dominio' :
       * 'domini'`, `.join(' oppure ')` — and no name is anybody's to resolve:
       * it is a number, a plan, a header's name.
       */
      const inner = readExpression(source, at + 2, true);

      written.push(text, ...inner.written);
      text = '';
      at = inner.end + 1;
      continue;
    }

    text += ch;
    at += 1;
  }

  written.push(text);

  return { written, named: everything ? [] : named, end: at };
}

/**
 * One expression, from `from` to the `,`, `)`, `}` or `;` that ends it.
 *
 * `everything` is the mode for the inside of a `${}`: literals are collected
 * wherever they sit, call arguments included, and names are not reported.
 * Outside one, a call's arguments are stepped over — `refusalMessage('not_https')`
 * names a function, and `not_https` is not something a seller reads.
 */
function readExpression(source: string, from: number, everything: boolean): Read {
  const written: string[] = [];
  const named: string[] = [];
  let depth = 0;
  let at = from;

  while (at < source.length) {
    const ch = source.charAt(at);

    if (depth === 0 && (ch === ',' || ch === ')' || ch === '}' || ch === ';')) break;

    if (source.startsWith('/*', at)) {
      at = source.indexOf('*/', at) + 2;
      continue;
    }

    if (source.startsWith('//', at)) {
      at = source.indexOf('\n', at) + 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const literal = readLiteral(source, at, everything);

      written.push(...literal.written);
      at = literal.end;
      continue;
    }

    if (IDENTIFIER_START.test(ch)) {
      let end = at;

      while (end < source.length && IDENTIFIER_PART.test(source.charAt(end))) end += 1;

      if (!everything) {
        named.push(source.slice(at, end));

        /* Its arguments and indexes are its own business. */
        while (source.charAt(end) === '(' || source.charAt(end) === '[') {
          end = pastClosing(source, end);
          while (end < source.length && IDENTIFIER_PART.test(source.charAt(end))) end += 1;
        }
      }

      at = end;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;

    at += 1;
  }

  return { written, named, end: at };
}

const CONSTRUCTED = /\bnew ([A-Z][A-Za-z]*Error)\(/gu;

/**
 * Every refusal a file constructs, with the words it writes and the names it
 * leaves to somebody else.
 *
 * `isRefusal` says which classes reach a caller with their message: the
 * `DomainError`s. A `PortNotConfiguredError` is constructed the same way and
 * read by nobody but the log.
 */
export const refusalsIn = (
  source: string,
  isRefusal: (className: string) => boolean,
): Refusal[] => {
  const constant = (name: string): Read | undefined => {
    const declared = new RegExp(
      `\\bconst ${name.replaceAll('$', '\\$')}\\b[^=;]*=(?!=|>)`,
      'u',
    ).exec(source);

    return declared === null
      ? undefined
      : readExpression(source, declared.index + declared[0].length, false);
  };

  /* A name defined in this file is read where it is defined, and so are the names it uses. */
  const resolve = (read: Read, seen: ReadonlySet<string> = new Set()): Read => {
    const written = [...read.written];
    const named: string[] = [];

    for (const name of read.named) {
      const local = seen.has(name) || name.includes('.') ? undefined : constant(name);

      if (local === undefined) {
        named.push(name);
        continue;
      }

      const inner = resolve(local, new Set([...seen, name]));

      written.push(...inner.written);
      named.push(...inner.named);
    }

    return { written, named, end: read.end };
  };

  return [...source.matchAll(CONSTRUCTED)]
    .filter((match) => isRefusal(match[1] ?? ''))
    .map((match) => {
      const start = match.index + match[0].length;
      const read = resolve(readExpression(source, start, false));

      return {
        line: source.slice(0, match.index).split('\n').length,
        error: match[1] ?? '',
        bare: source.slice(start, read.end).trim() === '' && source.charAt(read.end) === ')',
        written: read.written.join(' ').replaceAll(/\s+/gu, ' ').trim(),
        named: read.named,
      };
    });
};
