import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decodeFile,
  encodingNotice,
  looksDoubleEncoded,
} from '../src/features/catalog/encoding.js';

/**
 * Encoding detection (P1-17).
 *
 * **The fixtures are bytes, read as bytes.** A Windows-1252 fixture that some
 * tool helpfully re-saved as UTF-8 would leave every assertion here passing on
 * a file that no longer tests anything — so the first test checks the bytes
 * are still the ones the others rely on.
 *
 * Non-ASCII expectations are written with escapes where a character is easy to
 * lose in an editor: a non-breaking space, a control character, U+FFFD.
 */

/*
 * Paths from `import.meta.dirname`, not `new URL(..., import.meta.url)`: under
 * the jsdom environment the module URL is not a `file:` URL, and the resolved
 * path silently points at the drive root.
 */
const fixture = (name: string): Uint8Array =>
  readFileSync(join(import.meta.dirname, 'fixtures', name));

const REPLACEMENT = '\uFFFD';
const ACCENTED = ['Nebbiolo à', 'più lungo', 'sè stesso', 'così fresco'];

describe('the fixtures', () => {
  it('are still the bytes the tests rely on', () => {
    const cp1252 = Buffer.from(fixture('cp1252.csv'));

    // `à` as one Windows-1252 byte, not the two bytes UTF-8 would use.
    expect(cp1252.includes(Buffer.from([0xe0]))).toBe(true);
    expect(cp1252.includes(Buffer.from([0xc3, 0xa0]))).toBe(false);
    expect([...fixture('utf8-bom.csv').subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // CRLFs survive, which `eol=lf` would otherwise rewrite.
    expect(cp1252.includes(Buffer.from([0x0d, 0x0a]))).toBe(true);
  });

  it('are marked binary, so git cannot normalise them', () => {
    const attributes = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '.gitattributes'),
      'utf8',
    );

    expect(attributes).toContain('apps/dashboard/test/fixtures/*.csv binary');
  });
});

describe('decodeFile', () => {
  it('decodes Italian Excel’s Windows-1252 export, accents intact', () => {
    const decoded = decodeFile(fixture('cp1252.csv'));

    expect(decoded.encoding).toBe('windows-1252');
    expect(decoded.detected).toBe(true);
    for (const text of ACCENTED) expect(decoded.text).toContain(text);
    // The failure this exists for: replacement characters that look like text.
    expect(decoded.text).not.toContain(REPLACEMENT);
  });

  it('leaves a UTF-8 file as it is', () => {
    const decoded = decodeFile(fixture('utf8.csv'));

    expect(decoded.encoding).toBe('utf-8');
    for (const text of ACCENTED) expect(decoded.text).toContain(text);
  });

  it('drops the byte-order mark of Excel’s UTF-8 export', () => {
    const decoded = decodeFile(fixture('utf8-bom.csv'));

    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.text.startsWith('name;')).toBe(true);
  });

  it('decodes as the seller chose, even against the evidence', () => {
    /*
     * A file can be valid UTF-8 and still wrong, so the override wins. Forcing
     * Windows-1252 on a UTF-8 file produces exactly the double encoding a
     * seller would then see in the preview and switch back from.
     */
    const forced = decodeFile(fixture('utf8.csv'), 'windows-1252');

    expect(forced).toMatchObject({ encoding: 'windows-1252', detected: false });
    expect(forced.text).toContain('Nebbiolo Ã\u00A0');
  });

  it('would have returned replacement characters without fatal decoding', () => {
    // The trick, pinned: a non-fatal decoder "succeeds" on Windows-1252 bytes.
    const lenient = new TextDecoder('utf-8').decode(fixture('cp1252.csv'));

    expect(lenient).toContain(REPLACEMENT);
  });
});

describe('looksDoubleEncoded', () => {
  it.each([
    ['à read twice', 'Barbaresco Nebbiolo Ã\u00A0', true],
    ['ù read twice', 'piÃ¹ lungo', true],
    ['« » read twice', 'Â«BaroloÂ»', true],
    ['correct accents', 'così fresco', false],
    ['a capital Ã followed by ASCII', 'ÃRBORE', false],
  ])('%s', (_case, text, expected) => {
    expect(looksDoubleEncoded(text)).toBe(expected);
  });
});

describe('encodingNotice', () => {
  it('names a detected UTF-8 file and says nothing more', () => {
    expect(encodingNotice(decodeFile(fixture('utf8.csv')))).toBe('Codifica rilevata: UTF-8.');
  });

  it('names Windows-1252 and says what to do if the accents look wrong', () => {
    const notice = encodingNotice(decodeFile(fixture('cp1252.csv')));

    expect(notice).toMatch(/^Codifica rilevata: Windows-1252/);
    expect(notice).toContain('scegli UTF-8');
  });

  it('says the encoding was chosen, and warns about double encoding when it sees one', () => {
    const notice = encodingNotice(decodeFile(fixture('utf8.csv'), 'windows-1252'));

    expect(notice).toMatch(/^Codifica scelta: Windows-1252/);
    expect(notice).toContain('codifica sbagliata');
  });
});
