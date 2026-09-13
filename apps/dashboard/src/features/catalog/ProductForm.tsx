import { productRequest, type ProductRequest } from '@catalogorosso/api-client';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { CompletenessIndicator } from './CompletenessIndicator.js';
import { formatCents, parsePriceToCents, PRICE_MESSAGES } from './price.js';

/**
 * The canonical product editor (P1-01).
 *
 * **Its help text is the main lever on data quality, which is the main lever on
 * recommendation quality** — so two of the fields carry copy that is part of
 * the feature rather than decoration, and both are called out below.
 *
 * Validation runs against `productRequest` from `@catalogorosso/api-client`,
 * which `apps/api/test/product-contracts.test.ts` pins field-for-field against
 * the `drizzle-zod` contract the server validates with. That indirection exists
 * because this package cannot import `packages/db` — the dashboard bundles what
 * it imports, and the table contracts would pull `drizzle-orm` and the whole
 * schema into a browser. The test is what keeps the two from drifting, and
 * without it a field the form offers and the server strips would be a value a
 * seller typed and lost, with no error to explain it.
 */

/** Everything the form holds, as strings — which is what inputs produce. */
export interface ProductFormValues {
  sku: string;
  externalVariantId: string;
  name: string;
  producer: string;
  vintage: string;
  wineType: string;
  grapeVarieties: string;
  region: string;
  denomination: string;
  tastingNotes: string;
  foodPairings: string;
  styleTags: string;
  alcoholPct: string;
  price: string;
  currency: string;
  stockStatus: 'IN_STOCK' | 'OUT_OF_STOCK' | 'PREORDER';
  stockQty: string;
  productUrl: string;
  imageUrl: string;
}

export const emptyValues = (): ProductFormValues => ({
  sku: '',
  externalVariantId: '',
  name: '',
  producer: '',
  vintage: '',
  wineType: '',
  grapeVarieties: '',
  region: '',
  denomination: '',
  tastingNotes: '',
  foodPairings: '',
  styleTags: '',
  alcoholPct: '',
  price: '',
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
  stockQty: '',
  productUrl: '',
  imageUrl: '',
});

/** A stored product, back into the strings the form edits. */
export const valuesFrom = (product: Partial<ProductRequest>): ProductFormValues => ({
  ...emptyValues(),
  sku: product.sku ?? '',
  externalVariantId: product.externalVariantId ?? '',
  name: product.name ?? '',
  producer: product.producer ?? '',
  vintage: product.vintage === null || product.vintage === undefined ? '' : String(product.vintage),
  wineType: product.wineType ?? '',
  grapeVarieties: (product.grapeVarieties ?? []).join(', '),
  region: product.region ?? '',
  denomination: product.denomination ?? '',
  tastingNotes: product.tastingNotes ?? '',
  foodPairings: (product.foodPairings ?? []).join(', '),
  styleTags: (product.styleTags ?? []).join(', '),
  alcoholPct: product.alcoholPct ?? '',
  price: product.priceCents === undefined ? '' : formatCents(product.priceCents),
  currency: product.currency ?? 'EUR',
  stockStatus: product.stockStatus ?? 'IN_STOCK',
  stockQty:
    product.stockQty === null || product.stockQty === undefined ? '' : String(product.stockQty),
  productUrl: product.productUrl ?? '',
  imageUrl: product.imageUrl ?? '',
});

/** Field name to message, in Italian — this console has one language. */
export type FieldErrors = Partial<Record<keyof ProductFormValues, string>>;

/** Comma-separated free text into an array, or nothing when it is empty. */
const list = (value: string): string[] | undefined => {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

  return items.length === 0 ? undefined : items;
};

const text = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const wholeNumber = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
};

export type BuildResult =
  | { readonly ok: true; readonly payload: ProductRequest }
  | { readonly ok: false; readonly errors: FieldErrors };

/**
 * Turns the form's strings into the payload the API accepts, or into errors.
 *
 * **Exported and pure, so the mapping is testable without rendering anything.**
 * What a form *sends* is the part with consequences — a dropped field is a
 * value somebody typed and lost — and asserting it through a rendered component
 * tests the rendering as much as the mapping.
 */
export const buildPayload = (values: ProductFormValues): BuildResult => {
  const errors: FieldErrors = {};

  const price = parsePriceToCents(values.price);
  if (!price.ok) errors.price = PRICE_MESSAGES[price.reason];

  const vintage = wholeNumber(values.vintage);
  if (Number.isNaN(vintage)) errors.vintage = 'Scrivi un anno, ad esempio 2019.';

  const stockQty = wholeNumber(values.stockQty);
  if (Number.isNaN(stockQty)) errors.stockQty = 'Scrivi un numero intero di bottiglie.';

  const candidate = {
    sku: values.sku.trim(),
    name: values.name.trim(),
    wineType: values.wineType.trim(),
    currency: values.currency.trim(),
    stockStatus: values.stockStatus,
    priceCents: price.ok ? price.cents : -1,
    ...(text(values.externalVariantId) === undefined
      ? {}
      : { externalVariantId: text(values.externalVariantId) }),
    ...(text(values.producer) === undefined ? {} : { producer: text(values.producer) }),
    ...(vintage === undefined || Number.isNaN(vintage) ? {} : { vintage }),
    ...(list(values.grapeVarieties) === undefined
      ? {}
      : { grapeVarieties: list(values.grapeVarieties) }),
    ...(text(values.region) === undefined ? {} : { region: text(values.region) }),
    ...(text(values.denomination) === undefined ? {} : { denomination: text(values.denomination) }),
    ...(list(values.styleTags) === undefined ? {} : { styleTags: list(values.styleTags) }),
    ...(text(values.tastingNotes) === undefined ? {} : { tastingNotes: text(values.tastingNotes) }),
    ...(list(values.foodPairings) === undefined ? {} : { foodPairings: list(values.foodPairings) }),
    ...(text(values.alcoholPct) === undefined ? {} : { alcoholPct: text(values.alcoholPct) }),
    ...(stockQty === undefined || Number.isNaN(stockQty) ? {} : { stockQty }),
    ...(text(values.productUrl) === undefined ? {} : { productUrl: text(values.productUrl) }),
    ...(text(values.imageUrl) === undefined ? {} : { imageUrl: text(values.imageUrl) }),
  };

  /*
   * The shared contract has the last word, so a field the server would refuse
   * cannot leave this function — and the messages below are keyed off its
   * issues rather than duplicating its rules, because two copies of "a name is
   * required" disagree the first time one of them changes.
   */
  const parsed = productRequest.safeParse(candidate);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field !== 'string') continue;

      const key = field === 'priceCents' ? 'price' : (field as keyof ProductFormValues);
      errors[key] ??= issue.message;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (!parsed.success) return { ok: false, errors: { name: 'Controlla i campi.' } };

  return { ok: true, payload: parsed.data };
};

interface FieldProps {
  readonly id: keyof ProductFormValues;
  readonly label: string;
  readonly help?: string;
  readonly required?: boolean;
  readonly values: ProductFormValues;
  readonly errors: FieldErrors;
  readonly onInput: (id: keyof ProductFormValues, value: string) => void;
  readonly multiline?: boolean;
}

const Field = ({
  id,
  label,
  help,
  required,
  values,
  errors,
  onInput,
  multiline,
}: FieldProps): JSX.Element => {
  const error = errors[id];
  const helpId = help === undefined ? undefined : `${id}-help`;
  const errorId = error === undefined ? undefined : `${id}-error`;

  /*
   * `aria-describedby` carries both the help and the error, and `aria-invalid`
   * marks the field itself. A red border is not an error message to somebody
   * using a screen reader, and this is a form whose whole job is being filled
   * in correctly.
   */
  const described = [helpId, errorId].filter((value) => value !== undefined).join(' ');

  return (
    <div class="field">
      <label for={id}>
        {label}
        {required === true ? <abbr title="obbligatorio">*</abbr> : null}
      </label>

      {multiline === true ? (
        <textarea
          id={id}
          name={id}
          value={values[id]}
          aria-invalid={error === undefined ? undefined : 'true'}
          aria-describedby={described === '' ? undefined : described}
          onInput={(event) => {
            onInput(id, event.currentTarget.value);
          }}
        />
      ) : (
        <input
          id={id}
          name={id}
          value={values[id]}
          aria-invalid={error === undefined ? undefined : 'true'}
          aria-describedby={described === '' ? undefined : described}
          onInput={(event) => {
            onInput(id, event.currentTarget.value);
          }}
        />
      )}

      {help === undefined ? null : (
        <p class="field-help" id={helpId}>
          {help}
        </p>
      )}
      {error === undefined ? null : (
        <p class="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

export interface ProductFormProps {
  readonly initial?: ProductFormValues | undefined;
  readonly onSubmit: (payload: ProductRequest) => void;
  readonly submitLabel?: string | undefined;
}

/**
 * Four fieldsets, grouped the way §2.2 groups the template.
 *
 * The grouping is not cosmetic: Sommelier is the section that decides how well
 * a wine can be recommended, and putting it beside Commerce would let a seller
 * treat both as equally optional. Its fields are the ones the help text works
 * hardest on.
 */
export const ProductForm = ({ initial, onSubmit, submitLabel }: ProductFormProps): JSX.Element => {
  const [values, setValues] = useState<ProductFormValues>(initial ?? emptyValues());
  const [errors, setErrors] = useState<FieldErrors>({});

  const onInput = (id: keyof ProductFormValues, value: string) => {
    setValues((current) => ({ ...current, [id]: value }));

    /*
     * The error clears as soon as the field is touched, rather than waiting for
     * the next submit. Leaving it visible while somebody fixes the value tells
     * them their correction did not work.
     */
    setErrors((current) =>
      current[id] === undefined
        ? current
        : Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
    );
  };

  const field = (
    id: keyof ProductFormValues,
    label: string,
    options: { help?: string; required?: boolean; multiline?: boolean } = {},
  ) => (
    <Field
      id={id}
      label={label}
      values={values}
      errors={errors}
      onInput={onInput}
      {...(options.help === undefined ? {} : { help: options.help })}
      {...(options.required === undefined ? {} : { required: options.required })}
      {...(options.multiline === undefined ? {} : { multiline: options.multiline })}
    />
  );

  return (
    <form
      class="product-form"
      noValidate
      onSubmit={(event: Event) => {
        event.preventDefault();

        const result = buildPayload(values);
        if (!result.ok) {
          setErrors(result.errors);
          return;
        }

        setErrors({});
        onSubmit(result.payload);
      }}
    >
      <fieldset>
        <legend>Identità</legend>
        {field('sku', 'Codice (SKU)', {
          required: true,
          help: 'Il codice che usi tu. Deve essere unico nel tuo catalogo.',
        })}
        {field('name', 'Nome', { required: true })}
        {field('externalVariantId', 'ID variante Shopify', {
          /*
           * **Help text that is part of the feature.** Without this id the
           * Shopify cart adapter cannot add the wine to a cart (§1.6), so a
           * missing one is a recommendation that dead-ends at the checkout —
           * and nobody finds the field by guessing where Shopify keeps it.
           */
          help:
            'In Shopify: Prodotti → apri il prodotto → sezione Varianti → clicca la ' +
            'variante. È il numero alla fine dell’indirizzo della pagina. Senza questo ' +
            'ID il vino può essere consigliato ma non aggiunto al carrello.',
        })}
      </fieldset>

      <fieldset>
        <legend>Classificazione</legend>
        {field('wineType', 'Tipologia', {
          required: true,
          help: 'Rosso, bianco, orange, spumante…',
        })}
        {field('grapeVarieties', 'Vitigni', { help: 'Separati da virgola: Nebbiolo, Barbera' })}
        {field('region', 'Regione')}
        {field('denomination', 'Denominazione', { help: 'Barolo DOCG, Chianti Classico DOCG…' })}
        {field('vintage', 'Annata')}
        {field('styleTags', 'Stile', { help: 'Separati da virgola: strutturato, tannico' })}
      </fieldset>

      {/*
       * Above the Sommelier fieldset, not below it and not at the end of the
       * form (P1-13). This is the section whose fields the score is almost
       * entirely made of, so the prompt sits where the work is — a bar at the
       * bottom is read after somebody has already decided they are finished.
       */}
      <CompletenessIndicator product={values} />

      <fieldset>
        <legend>Sommelier</legend>
        {field('tastingNotes', 'Note di degustazione', {
          multiline: true,
          help: 'Come si presenta e che sensazioni dà. È il testo che il sommelier legge.',
        })}
        {field('foodPairings', 'Abbinamenti', {
          /*
           * **The second piece of load-bearing copy.** "Carne" matches almost
           * any question and distinguishes nothing; "brasato al Barolo" is what
           * lets the recommendation be right rather than merely plausible. The
           * seller is the only person who knows this, and the only reason they
           * would write it specifically is being told why.
           */
          help:
            'Separati da virgola. Più sei preciso, migliori sono i consigli: ' +
            '“brasato al Barolo” aiuta molto più di “carne”.',
        })}
        {field('alcoholPct', 'Gradazione', { help: 'Ad esempio 14.50' })}
      </fieldset>

      <fieldset>
        <legend>Commercio</legend>
        {field('price', 'Prezzo', { required: true, help: 'Ad esempio 12,50' })}
        {field('currency', 'Valuta', { required: true })}

        <div class="field">
          <label for="stockStatus">Disponibilità</label>
          <select
            id="stockStatus"
            name="stockStatus"
            value={values.stockStatus}
            onInput={(event) => {
              onInput('stockStatus', event.currentTarget.value);
            }}
          >
            <option value="IN_STOCK">Disponibile</option>
            <option value="OUT_OF_STOCK">Esaurito</option>
            <option value="PREORDER">Su ordinazione</option>
          </select>
        </div>

        {field('stockQty', 'Bottiglie in magazzino')}
        {field('productUrl', 'Link alla scheda')}
        {field('imageUrl', 'Link all’immagine')}
      </fieldset>

      <button type="submit">{submitLabel ?? 'Salva'}</button>
    </form>
  );
};
