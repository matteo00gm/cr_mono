import { describe, expect, it } from 'vitest';

import {
  normalisePec,
  normaliseSdiCode,
  normaliseVatId,
  readCheckoutTaxDetails,
  TAX_CUSTOM_FIELDS,
} from '../../src/billing/tax-details.js';

/**
 * The invoice details an Italian business gives on Checkout (P5-02a): what is
 * accepted, how it is written down, and what is refused — before SdI refuses
 * it after the payment.
 */

/* Well formed, and nobody's: the check digit computed for these ten digits. */
const PARTITA_IVA = '12345678903';
/* The textbook example's shape. */
const CODICE_FISCALE = 'RSSMRA80A01H501U';

describe('a Partita IVA or Codice Fiscale', () => {
  it.each([
    [PARTITA_IVA, PARTITA_IVA],
    ['IT12345678903', PARTITA_IVA],
    ['it 123 456 789 03', PARTITA_IVA],
    ['123.456.789-03', PARTITA_IVA],
    [CODICE_FISCALE, CODICE_FISCALE],
    ['rssmra80a01h501u', CODICE_FISCALE],
    /* Omocodia: a digit turned into a letter, as the Agenzia does for duplicates. */
    ['RSSMRA80A01H50MU', 'RSSMRA80A01H50MU'],
  ])('accepts %s as %s', (raw, written) => {
    expect(normaliseVatId(raw)).toBe(written);
  });

  it.each([
    ['a mistyped check digit', '12345678904'],
    ['ten digits', '1234567890'],
    ['twelve digits', '123456789031'],
    ['a foreign VAT number', 'DE123456789'],
    ['a Codice Fiscale out of shape', 'RSSMRA8XA01H501U'],
    ['nothing at all', ''],
  ])('refuses %s', (_what, raw) => {
    expect(normaliseVatId(raw)).toBeUndefined();
  });
});

describe('a Codice Destinatario', () => {
  it('is seven letters and digits, written uppercase', () => {
    expect(normaliseSdiCode(' m5uxcr1 ')).toBe('M5UXCR1');
    expect(normaliseSdiCode('0000000')).toBe('0000000');
  });

  it.each(['M5UXCR', 'M5UXCR12', 'M5UX-R1'])('refuses %s', (raw) => {
    expect(normaliseSdiCode(raw)).toBeUndefined();
  });
});

describe('a PEC address', () => {
  it('is an address, written lowercase', () => {
    expect(normalisePec(' Fatture@Cantina.PEC.it ')).toBe('fatture@cantina.pec.it');
  });

  it('refuses what is not an address', () => {
    expect(normalisePec('cantina.pec.it')).toBeUndefined();
  });
});

describe('the fields on Stripe’s page', () => {
  it('are three, optional, under letter-and-digit keys as Stripe requires', () => {
    expect(TAX_CUSTOM_FIELDS.map((field) => [field.key, field.optional])).toEqual([
      ['partitaiva', true],
      ['codicesdi', true],
      ['pec', true],
    ]);

    for (const field of TAX_CUSTOM_FIELDS) {
      expect(field.key).toMatch(/^[a-z0-9]+$/u);
      expect(field.label.custom.length).toBeLessThanOrEqual(50);
    }
  });
});

describe('a completed Checkout, read', () => {
  const completed = (fields: readonly { key: string; value: string | null }[] | null) => ({
    data: {
      object: {
        custom_fields:
          fields === null
            ? null
            : fields.map(({ key, value }) => ({ key, type: 'text', text: { value } })),
      },
    },
  });

  it('gives every field well formed', () => {
    expect(
      readCheckoutTaxDetails(
        completed([
          { key: 'partitaiva', value: 'IT12345678903' },
          { key: 'codicesdi', value: 'm5uxcr1' },
          { key: 'pec', value: 'Fatture@Cantina.pec.it' },
        ]),
      ),
    ).toEqual({
      details: { vatId: PARTITA_IVA, sdiCode: 'M5UXCR1', pecAddress: 'fatture@cantina.pec.it' },
      invalid: [],
    });
  });

  it('gives nothing, and nothing wrong, for a Checkout without them', () => {
    const none = { details: { vatId: null, sdiCode: null, pecAddress: null }, invalid: [] };

    expect(readCheckoutTaxDetails(completed(null))).toEqual(none);
    expect(readCheckoutTaxDetails(completed([{ key: 'partitaiva', value: null }]))).toEqual(none);
    expect(readCheckoutTaxDetails(completed([{ key: 'codicesdi', value: '   ' }]))).toEqual(none);
    expect(readCheckoutTaxDetails({ data: { object: {} } })).toEqual(none);
    expect(readCheckoutTaxDetails('not an event')).toEqual(none);
  });

  it('leaves out a field filled in wrongly, and names it', () => {
    expect(
      readCheckoutTaxDetails(
        completed([
          { key: 'partitaiva', value: '12345678904' },
          { key: 'codicesdi', value: 'M5UXCR1' },
          { key: 'pec', value: 'not-an-address' },
        ]),
      ),
    ).toEqual({
      details: { vatId: null, sdiCode: 'M5UXCR1', pecAddress: null },
      invalid: ['vat_id', 'pec_address'],
    });
  });

  it('reads only our keys', () => {
    expect(
      readCheckoutTaxDetails(completed([{ key: 'vatid', value: PARTITA_IVA }])).details.vatId,
    ).toBeNull();
  });
});
