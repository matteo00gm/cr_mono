import type { ApiClient, Product } from '@catalogorosso/api-client';
import { INLINE_EDIT_FIELDS, type InlineEditField } from '@catalogorosso/core/inline-edit';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { GridColumn } from './CatalogGrid.js';
import { formatCents, parsePriceToCents, PRICE_MESSAGES } from './price.js';
import { describeFailure } from './request-failure.js';

/**
 * Price and stock, edited in the grid (P1-11).
 *
 * **Three fields, and the list is not this file's to widen.** It lives in
 * `@catalogorosso/core/inline-edit`, beside a test that runs every field
 * through the real content hash: the point of editing in a cell is that it
 * costs nothing, and a field the model reads would make every pause in typing
 * an embedding call.
 *
 * What a seller types is shown at once and saved after a pause — one `PATCH`
 * per wine carrying only what changed. A failure puts the saved value back and
 * says so in the cell; nothing is left looking saved that is not.
 */

/**
 * How long typing must pause before a save.
 *
 * Long enough that "19,50" is one request rather than five, short enough that
 * a seller moving to the next row has usually already been saved. Leaving the
 * cell saves at once, so the delay is never what stands between a seller and a
 * saved price.
 */
export const SAVE_DELAY_MS = 800;

export const STOCK_LABEL: Readonly<Record<Product['stockStatus'], string>> = {
  IN_STOCK: 'Disponibile',
  OUT_OF_STOCK: 'Esaurito',
  PREORDER: 'In prevendita',
};

const STOCK_STATUSES = Object.keys(STOCK_LABEL) as Product['stockStatus'][];

/** The body of an inline save. Only the inline fields can be in it, by type. */
export type InlineChanges = { [F in InlineEditField]?: Product[F] };

/** Per field, the text an input holds (or a message about it). */
export type FieldText = Partial<Record<InlineEditField, string>>;

type Parsed =
  | { readonly ok: true; readonly changes: InlineChanges }
  | { readonly ok: false; readonly message: string };

/** One cell's text, as the value the API takes — or what is wrong with it. */
export const parseInline = (field: InlineEditField, raw: string): Parsed => {
  if (field === 'priceCents') {
    const price = parsePriceToCents(raw);
    return price.ok
      ? { ok: true, changes: { priceCents: price.cents } }
      : { ok: false, message: PRICE_MESSAGES[price.reason] };
  }

  if (field === 'stockQty') {
    const text = raw.trim();
    /*
     * Empty means "not counted", which is `null` — not zero. A seller clearing
     * the cell is saying they do not track this wine's bottles; saving 0 would
     * tell a visitor it is sold out.
     */
    if (text === '') return { ok: true, changes: { stockQty: null } };

    return /^\d{1,9}$/.test(text)
      ? { ok: true, changes: { stockQty: Number(text) } }
      : { ok: false, message: 'Scrivi un numero intero di bottiglie, oppure lascia vuoto.' };
  }

  const status = STOCK_STATUSES.find((candidate) => candidate === raw);
  return status === undefined
    ? { ok: false, message: 'Scegli una disponibilità.' }
    : { ok: true, changes: { stockStatus: status } };
};

/** A saved value as the text its input shows. */
export const displayOf = (product: Product, field: InlineEditField): string => {
  if (field === 'priceCents') return formatCents(product.priceCents);
  if (field === 'stockQty') return product.stockQty === null ? '' : String(product.stockQty);
  return product.stockStatus;
};

/**
 * What typed text would change on the saved wine.
 *
 * Walks `INLINE_EDIT_FIELDS` rather than the typed object, so nothing but those
 * fields can reach the body. A value typed back to what is saved is not a
 * change, and an invalid one is never sent — it stays in its cell with its
 * message until it is fixed.
 */
export const changesFrom = (
  product: Product,
  typed: FieldText,
): { readonly changes: InlineChanges; readonly sent: readonly InlineEditField[] } => {
  let changes: InlineChanges = {};
  const sent: InlineEditField[] = [];

  for (const field of INLINE_EDIT_FIELDS) {
    const raw = typed[field];
    if (raw === undefined) continue;

    const parsed = parseInline(field, raw);
    if (!parsed.ok || parsed.changes[field] === product[field]) continue;

    changes = { ...changes, ...parsed.changes };
    sent.push(field);
  }

  return { changes, sent };
};

const without = (
  row: FieldText | undefined,
  drop: (field: InlineEditField, raw: string) => boolean,
): FieldText =>
  Object.fromEntries(
    Object.entries(row ?? {}).filter(([field, raw]) => !drop(field as InlineEditField, raw)),
  );

export interface InlineEditor {
  readonly valueOf: (product: Product, field: InlineEditField) => string;
  readonly errorsOf: (productId: string) => FieldText | undefined;
  readonly edit: (product: Product, field: InlineEditField, raw: string) => void;
  /** Save now, if anything is waiting. Called when a cell loses focus. */
  readonly commit: (productId: string) => void;
}

export const useInlineEdit = ({
  client,
  onSaved,
}: {
  readonly client: ApiClient;
  /** Receives the server's copy of the wine after a save. */
  readonly onSaved: (product: Product) => void;
}): InlineEditor => {
  const [drafts, setDrafts] = useState<Readonly<Record<string, FieldText>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, FieldText>>>({});

  /*
   * Refs, because saves outlive the render that scheduled them: a timer fires
   * and a response lands against whatever the seller has typed *since*, and a
   * closure over one render's state would save or discard the wrong text.
   */
  const draftsRef = useRef(drafts);
  const known = useRef(new Map<string, Product>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Set<string>());
  const again = useRef(new Set<string>());
  const mounted = useRef(true);
  const saved = useRef(onSaved);
  saved.current = onSaved;

  const writeDrafts = (next: Readonly<Record<string, FieldText>>): void => {
    draftsRef.current = next;
    if (mounted.current) setDrafts(next);
  };

  const setFieldError = (id: string, field: InlineEditField, message: string | undefined): void => {
    if (!mounted.current) return;
    setErrors((current) => ({
      ...current,
      [id]: {
        ...without(current[id], (name) => name === field),
        ...(message === undefined ? {} : { [field]: message }),
      },
    }));
  };

  /** Drops typed text for `fields`, but only where it is still what was sent. */
  const forget = (id: string, fields: readonly InlineEditField[], sentText: FieldText): void => {
    writeDrafts({
      ...draftsRef.current,
      [id]: without(
        draftsRef.current[id],
        (field, raw) => fields.includes(field) && sentText[field] === raw,
      ),
    });
  };

  const flush = (id: string): void => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }

    /*
     * **Never two saves for one wine at once.** Each carries absolute values,
     * and two in flight can land in either order — so the older price could be
     * the one left standing. The later edit waits and goes when the first
     * answers.
     */
    if (inFlight.current.has(id)) {
      again.current.add(id);
      return;
    }

    const product = known.current.get(id);
    const typed = draftsRef.current[id];
    if (product === undefined || typed === undefined) return;

    const { changes, sent } = changesFrom(product, typed);

    // Typed back to what is saved: nothing to send, and no draft left to show.
    const unchanged = INLINE_EDIT_FIELDS.filter((field) => {
      const raw = typed[field];
      return raw !== undefined && !sent.includes(field) && parseInline(field, raw).ok;
    });
    forget(id, unchanged, typed);

    if (sent.length === 0) return;

    inFlight.current.add(id);

    void client
      .request('PATCH /v1/dashboard/products/:id', { params: { id }, body: changes })
      .then(
        (product) => {
          known.current.set(id, product);
          saved.current(product);
          forget(id, sent, typed);
        },
        (error: unknown) => {
          // The rollback: the cell shows the saved value again, and says why.
          forget(id, sent, typed);
          const message = describeFailure('Modifica non salvata.', error);
          for (const field of sent) setFieldError(id, field, message);
        },
      )
      .finally(() => {
        inFlight.current.delete(id);
        if (again.current.delete(id)) flush(id);
      });
  };

  useEffect(() => {
    mounted.current = true;

    return () => {
      /*
       * A seller who types a price and navigates away within the pause expects
       * it saved. The request still goes; only the local state is not updated.
       */
      mounted.current = false;
      for (const id of [...timers.current.keys()]) flush(id);
    };
  }, []);

  return {
    valueOf: (product, field) => {
      known.current.set(product.id, product);
      return drafts[product.id]?.[field] ?? displayOf(product, field);
    },

    errorsOf: (productId) => {
      const row = errors[productId];
      return row === undefined || Object.keys(row).length === 0 ? undefined : row;
    },

    edit: (product, field, raw) => {
      known.current.set(product.id, product);
      writeDrafts({
        ...draftsRef.current,
        [product.id]: { ...draftsRef.current[product.id], [field]: raw },
      });

      const parsed = parseInline(field, raw);
      setFieldError(product.id, field, parsed.ok ? undefined : parsed.message);

      const existing = timers.current.get(product.id);
      if (existing !== undefined) clearTimeout(existing);
      timers.current.set(
        product.id,
        setTimeout(() => {
          flush(product.id);
        }, SAVE_DELAY_MS),
      );
    },

    commit: (productId) => {
      if (timers.current.has(productId)) flush(productId);
    },
  };
};

const invalid = (editor: InlineEditor, id: string, field: InlineEditField): 'true' | undefined =>
  editor.errorsOf(id)?.[field] === undefined ? undefined : 'true';

/**
 * The three editable columns.
 *
 * **Only a saved row is editable.** A draft pasted or imported (P1-14, P1-22)
 * has no server id to patch, so the same columns render it as text.
 */
export const inlineEditColumns = (
  editor: InlineEditor,
): Readonly<Record<InlineEditField, GridColumn<Product>>> => ({
  priceCents: {
    key: 'priceCents',
    header: 'Prezzo',
    width: '9rem',
    numeric: true,
    cell: (row): JSX.Element | string =>
      row.state !== 'saved' ? (
        displayOf(row.data, 'priceCents')
      ) : (
        <span class="cr-inline">
          <input
            class="cr-inline__input cr-inline__input--numeric"
            inputMode="decimal"
            aria-label={`Prezzo di ${row.data.name}`}
            aria-invalid={invalid(editor, row.id, 'priceCents')}
            value={editor.valueOf(row.data, 'priceCents')}
            onInput={(event) => {
              editor.edit(row.data, 'priceCents', event.currentTarget.value);
            }}
            onBlur={() => {
              editor.commit(row.id);
            }}
          />
          <span class="cr-inline__unit">{row.data.currency}</span>
        </span>
      ),
  },

  stockStatus: {
    key: 'stockStatus',
    header: 'Disponibilità',
    width: '10rem',
    cell: (row): JSX.Element | string =>
      row.state !== 'saved' ? (
        STOCK_LABEL[row.data.stockStatus]
      ) : (
        <select
          class="cr-inline__input"
          aria-label={`Disponibilità di ${row.data.name}`}
          value={editor.valueOf(row.data, 'stockStatus')}
          onChange={(event) => {
            editor.edit(row.data, 'stockStatus', event.currentTarget.value);
          }}
          onBlur={() => {
            editor.commit(row.id);
          }}
        >
          {STOCK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STOCK_LABEL[status]}
            </option>
          ))}
        </select>
      ),
  },

  stockQty: {
    key: 'stockQty',
    header: 'Bottiglie',
    width: '6rem',
    numeric: true,
    cell: (row): JSX.Element | string =>
      row.state !== 'saved' ? (
        displayOf(row.data, 'stockQty')
      ) : (
        <input
          class="cr-inline__input cr-inline__input--numeric"
          inputMode="numeric"
          aria-label={`Bottiglie di ${row.data.name}`}
          aria-invalid={invalid(editor, row.id, 'stockQty')}
          value={editor.valueOf(row.data, 'stockQty')}
          onInput={(event) => {
            editor.edit(row.data, 'stockQty', event.currentTarget.value);
          }}
          onBlur={() => {
            editor.commit(row.id);
          }}
        />
      ),
  },
});
