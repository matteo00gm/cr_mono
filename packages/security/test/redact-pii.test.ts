import { describe, expect, it } from 'vitest';

import { OMITTED, redactPii } from '../src/redact-pii.js';

/**
 * What a visitor volunteers, removed before it goes anywhere (P2-33).
 *
 * **Two failures, and the second is the one nobody reports.** Missing an email
 * sends a stranger's address to a model and keeps it for ninety days. Redacting
 * a vintage turns "un Barolo del 2016" into "un Barolo del [omesso]" — which
 * breaks the product for every visitor who mentions a year, a price or a wine
 * with a number in its name, and produces no error anywhere.
 *
 * So the false-positive half of this suite is as long as the true-positive
 * half, and deliberately.
 */

const clean = (message: string): string => redactPii(message).text;

describe('what is removed', () => {
  it.each([
    ['an email address', 'Mandami la lista a mario.rossi@example.com grazie'],
    ['an email with a plus tag', 'scrivimi a mario+vini@example.co.uk'],
    ['an email with accented letters', 'scrivi a josé@bodegas.es'],
    ['an Italian mobile', 'Chiamami al 333 123 4567'],
    ['an international number', 'il mio numero è +39 02 1234 5678'],
    ['a number written with dots', 'chiama 02.1234.5678'],
    ['a number written with dashes', 'chiama 055-123-4567'],
    ['a codice fiscale', 'il mio CF è RSSMRA85T10A562S'],
    ['a card-like digit run', 'la carta è 4111111111111111'],
  ])('removes %s', (_name, message) => {
    const { text, removed } = redactPii(message);

    expect(text).toContain(OMITTED);
    expect(removed).toBeGreaterThan(0);
  });

  it('leaves the sentence readable', () => {
    // Replaced rather than deleted: "Chiama il" on its own is a fragment, and a
    // model will do its best with it.
    expect(clean('Chiama il 333 123 4567 per favore')).toBe(`Chiama il ${OMITTED} per favore`);
  });

  it('removes several things from one message', () => {
    const { removed } = redactPii('scrivi a mario@example.com o chiama +39 333 123 4567');

    expect(removed).toBe(2);
  });

  it('never reports what it removed, only how much', () => {
    /*
     * The count goes to a log; the value must not. Reporting the value would
     * put it in exactly the place this function exists to keep it out of.
     */
    const result = redactPii('mario@example.com');

    expect(Object.values(result)).not.toContain('mario@example.com');
    expect(result.removed).toBe(1);
  });

  it('takes the whole address, not half of it', () => {
    /*
     * **The reason the order in `PATTERNS` is not arbitrary.** This local part
     * is phone-shaped: dot-separated groups of three and four digits. A phone
     * pattern running first claims them, leaves `mario.[omesso]@example.com`,
     * and the email pattern can no longer match what is left — so the domain,
     * and half the address, go to the model anyway.
     */
    expect(clean('scrivi a mario.333.123.4567@example.com')).toBe(`scrivi a ${OMITTED}`);
  });
});

describe('what survives, because over-redaction breaks the product', () => {
  it.each([
    ['a vintage', 'cerco un Barolo del 2016'],
    ['two vintages', 'ho 2016 e 2019, quale scelgo?'],
    ['a price in euros', 'qualcosa sotto i 25 euro'],
    ['a price with cents', 'costa 24,50 euro?'],
    ['a price with a separator', 'ho un budget di 1.500 euro per la cantina'],
    ['a wine with a number in the name', 'avete il Tignanello 2018?'],
    ['an alcohol percentage', 'un rosso da 13,5 gradi'],
    ['a quantity', 'vorrei 6 bottiglie'],
    ['a case count', 'due casse da 12'],
    ['a year range', 'annate dal 2015 al 2020'],
    ['a denomination with digits', 'un Chianti Classico DOCG 2019'],
  ])('leaves %s untouched', (_name, message) => {
    const { text, removed } = redactPii(message);

    expect(text).toBe(message);
    expect(removed).toBe(0);
  });

  it('leaves an ordinary question exactly as typed', () => {
    const question = 'Cosa mi consigliate per una bistecca alla fiorentina?';

    expect(clean(question)).toBe(question);
  });

  it('does not treat a word that looks like a codice fiscale as one', () => {
    // Six letters and digits in the wrong arrangement is not the pattern, and
    // a looser match would eat a wine name.
    expect(clean('BAROLO 2016 RISERVA')).toBe('BAROLO 2016 RISERVA');
  });
});

describe('running it twice', () => {
  it('removes nothing the second time', () => {
    /*
     * The entry point is the only caller that should run it, and a second
     * caller appearing later is more likely than not. Idempotence means that
     * costs nothing rather than producing `[omesso][omesso]`.
     */
    const once = redactPii('scrivi a mario@example.com');
    const twice = redactPii(once.text);

    expect(twice.text).toBe(once.text);
    expect(twice.removed).toBe(0);
  });
});

describe('an empty message', () => {
  it('is left alone and reports nothing', () => {
    expect(redactPii('')).toEqual({ text: '', removed: 0 });
  });
});
