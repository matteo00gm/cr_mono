import { z } from 'zod';

import { looksLikeAddress, normaliseAddress } from '../email/address.js';

/**
 * What an Italian business needs on its invoice, asked for on Checkout
 * (P5-02a): a Partita IVA or Codice Fiscale, and where the invoice goes — a
 * Codice Destinatario for SdI, or a PEC address.
 *
 * **Asked, never required.** Stripe's custom fields cannot depend on the
 * buyer's country, and a winery outside Italy has none of these; every field
 * is optional so its Checkout is no longer than it was. A business that leaves
 * them out gets a receipt rather than a FatturaPA (P5-03a).
 *
 * **Checked here, stored only when right.** Stripe checks lengths and nothing
 * else, and an invoice sent to SdI with a mistyped Partita IVA is rejected —
 * after the payment, where nobody sees it. A value that is not well formed is
 * left out and named in the log, never quoted: a Codice Fiscale is a person's.
 */

/** The custom fields' keys. Stripe allows letters and digits only. */
export const TAX_FIELD_KEYS = {
  vatId: 'partitaiva',
  sdiCode: 'codicesdi',
  pecAddress: 'pec',
} as const;

/** The three fields on Stripe's page, in Italian: the people they are for read it. */
export const TAX_CUSTOM_FIELDS = [
  {
    key: TAX_FIELD_KEYS.vatId,
    label: { type: 'custom', custom: 'Partita IVA o Codice Fiscale' },
    type: 'text',
    optional: true,
    /* 11 for a Partita IVA, 13 with `IT` before it, 16 for a Codice Fiscale. */
    text: { minimum_length: 11, maximum_length: 16 },
  },
  {
    key: TAX_FIELD_KEYS.sdiCode,
    label: { type: 'custom', custom: 'Codice Destinatario SdI' },
    type: 'text',
    optional: true,
    text: { minimum_length: 7, maximum_length: 7 },
  },
  {
    key: TAX_FIELD_KEYS.pecAddress,
    label: { type: 'custom', custom: 'Indirizzo PEC (se non hai il codice SdI)' },
    type: 'text',
    optional: true,
    text: { maximum_length: 255 },
  },
] as const;

export interface TaxDetails {
  /** Eleven digits, or a sixteen-character Codice Fiscale, uppercase. */
  readonly vatId: string | null;
  /** Seven characters, uppercase. */
  readonly sdiCode: string | null;
  /** Lowercase. */
  readonly pecAddress: string | null;
}

export type TaxField = 'vat_id' | 'sdi_code' | 'pec_address';

/**
 * Whether eleven digits are a Partita IVA: its last digit is the check digit
 * of the first ten, the odd places counted as they are and the even ones
 * doubled, less nine when that is more than nine.
 */
const isPartitaIva = (digits: string): boolean => {
  if (!/^[0-9]{11}$/u.test(digits)) return false;

  let sum = 0;

  for (let place = 0; place < 10; place += 1) {
    const digit = Number(digits[place]);
    const doubled = place % 2 === 1 ? digit * 2 : digit;

    sum += doubled > 9 ? doubled - 9 : doubled;
  }

  return (10 - (sum % 10)) % 10 === Number(digits[10]);
};

/**
 * A personal Codice Fiscale's shape: surname and name letters, year, month
 * letter, day, birthplace, check letter — with the digits that omocodia may
 * have turned into letters (L–V).
 */
const CODICE_FISCALE =
  /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/u;

/** A Partita IVA (an `IT` prefix dropped) or a Codice Fiscale, or `undefined`. */
export const normaliseVatId = (raw: string): string | undefined => {
  const compact = raw.replace(/[\s.-]/gu, '').toUpperCase();
  const vat = /^IT[0-9]{11}$/u.test(compact) ? compact.slice(2) : compact;

  if (isPartitaIva(vat)) return vat;

  return CODICE_FISCALE.test(vat) ? vat : undefined;
};

/** Seven letters and digits, as the Agenzia delle Entrate issues them. */
export const normaliseSdiCode = (raw: string): string | undefined => {
  const code = raw.trim().toUpperCase();

  return /^[A-Z0-9]{7}$/u.test(code) ? code : undefined;
};

export const normalisePec = (raw: string): string | undefined => {
  const address = normaliseAddress(raw);

  return looksLikeAddress(address) ? address : undefined;
};

const checkoutFields = z.object({
  data: z.object({
    object: z.object({
      custom_fields: z
        .array(
          z.object({
            key: z.string(),
            text: z.object({ value: z.string().nullable() }).nullish(),
          }),
        )
        .nullish(),
    }),
  }),
});

/**
 * The tax details a completed Checkout carries, each well formed or `null`,
 * and the fields that were filled in but not well formed (P5-02a).
 *
 * A Checkout with none of them — a winery outside Italy, or one that skipped
 * them — is all `null` and nothing invalid.
 */
export const readCheckoutTaxDetails = (
  payload: unknown,
): { readonly details: TaxDetails; readonly invalid: readonly TaxField[] } => {
  const parsed = checkoutFields.safeParse(payload);
  const fields = parsed.success ? (parsed.data.data.object.custom_fields ?? []) : [];
  const valueOf = (key: string): string | undefined => {
    const value = fields.find((field) => field.key === key)?.text?.value?.trim();

    return value === undefined || value === '' ? undefined : value;
  };

  const invalid: TaxField[] = [];
  const read = (
    key: string,
    field: TaxField,
    normalise: (raw: string) => string | undefined,
  ): string | null => {
    const raw = valueOf(key);

    if (raw === undefined) return null;

    const value = normalise(raw);

    if (value === undefined) invalid.push(field);

    return value ?? null;
  };

  return {
    details: {
      vatId: read(TAX_FIELD_KEYS.vatId, 'vat_id', normaliseVatId),
      sdiCode: read(TAX_FIELD_KEYS.sdiCode, 'sdi_code', normaliseSdiCode),
      pecAddress: read(TAX_FIELD_KEYS.pecAddress, 'pec_address', normalisePec),
    },
    invalid,
  };
};
