/**
 * A file's bytes into text (P1-17).
 *
 * **Italian Excel's default CSV export is not UTF-8**, it is Windows-1252. Read
 * as UTF-8, every `à è ò ì` in it becomes a replacement character — and the
 * damage does not stop at the preview: those strings would be saved, shown to
 * visitors, and embedded, so retrieval would be searching a catalogue in which
 * "Nebbiolo à" no longer exists.
 *
 * **`fatal: true` is the whole trick.** A default `TextDecoder` never fails: it
 * turns bytes that are not UTF-8 into U+FFFD and returns text that looks valid.
 * Asking it to throw is what makes "is this UTF-8?" answerable at all, and the
 * answer decides the fallback.
 */

export type Encoding = 'utf-8' | 'windows-1252';

export const ENCODING_LABEL: Readonly<Record<Encoding, string>> = {
  'utf-8': 'UTF-8',
  'windows-1252': 'Windows-1252 (Excel italiano)',
};

export interface Decoded {
  readonly text: string;
  readonly encoding: Encoding;
  /** False when the seller chose the encoding rather than the file suggesting it. */
  readonly detected: boolean;
}

/**
 * Decodes bytes as UTF-8 if they are valid UTF-8, as Windows-1252 otherwise,
 * or as the encoding the seller chose.
 *
 * **The override exists because a file can be valid UTF-8 and still wrong.**
 * A Windows-1252 file with no accented letters is byte-for-byte valid UTF-8, and
 * so is a file that was already mangled once by an earlier wrong save. Detection
 * cannot tell those apart; the seller looking at the preview can.
 *
 * A UTF-8 byte-order mark is removed here, by `TextDecoder` itself.
 */
export const decodeFile = (bytes: ArrayBuffer | Uint8Array, override?: Encoding): Decoded => {
  if (override !== undefined) {
    return { text: new TextDecoder(override).decode(bytes), encoding: override, detected: false };
  }

  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      encoding: 'utf-8',
      detected: true,
    };
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(bytes),
      encoding: 'windows-1252',
      detected: true,
    };
  }
};

/**
 * `Ã` or `Â` followed by a character from the Latin-1 supplement.
 *
 * That pair is what a UTF-8 accented letter looks like after being read once as
 * Windows-1252 and saved again — "è" becomes "Ã¨". Written with escapes because
 * the range starts at a control character, which nobody can see in a diff.
 */
const DOUBLE_ENCODED = /[ÃÂ][\u0080-¿]/;

/**
 * Whether decoded text carries the signature of an earlier double encoding.
 *
 * It is valid UTF-8, so detection accepts it, and it is wrong. Worth one
 * sentence on screen before a seller saves a catalogue of it.
 */
export const looksDoubleEncoded = (text: string): boolean => DOUBLE_ENCODED.test(text);

/** What the screen says about the encoding, and what to do if it looks wrong. */
export const encodingNotice = (decoded: Decoded): string => {
  const label = ENCODING_LABEL[decoded.encoding];
  const lead = decoded.detected ? `Codifica rilevata: ${label}.` : `Codifica scelta: ${label}.`;

  if (looksDoubleEncoded(decoded.text)) {
    return `${lead} Il testo contiene sequenze come «Ã¨» al posto delle lettere accentate: probabilmente il file è stato salvato con la codifica sbagliata. Controlla l’anteprima prima di importare.`;
  }

  if (decoded.encoding === 'windows-1252') {
    return `${lead} Se le lettere accentate non appaiono corrette nell’anteprima, scegli UTF-8.`;
  }

  return lead;
};
