import { ApiError, type Product } from '@catalogorosso/api-client';
import { INLINE_EDIT_FIELDS } from '@catalogorosso/core/inline-edit';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CatalogGrid } from '../src/features/catalog/CatalogGrid.js';
import { CatalogScreen } from '../src/features/catalog/CatalogScreen.js';
import {
  changesFrom,
  inlineEditColumns,
  parseInline,
  SAVE_DELAY_MS,
  useInlineEdit,
} from '../src/features/catalog/InlineEdit.js';
import { PRICE_MESSAGES } from '../src/features/catalog/price.js';
import { fakeClient, listOf, type Route, type Sent } from './support/client.js';
import { wine } from './support/wine.js';

/**
 * Inline edit of price and stock (P1-11).
 *
 * **What is saved, and when, is the whole feature** — so the assertions are on
 * the requests: how many, carrying what, and what the cell shows when one
 * fails. A cell that looks saved and is not is the failure a seller would never
 * notice until a customer did.
 */

const LIST = 'GET /v1/dashboard/products';
const PATCH = 'PATCH /v1/dashboard/products/:id';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const BAROLO = wine({ id: 'a', name: 'Barolo Bussia', priceCents: 2500, stockQty: 24 });

const mount = (patch: Route, product: Product = BAROLO) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fake = fakeClient({ [LIST]: () => Promise.resolve(listOf([product])), [PATCH]: patch });
  const view = render(<CatalogScreen client={fake.client} />);
  return { ...fake, ...view };
};

const patchesOf = (request: { mock: { calls: unknown[][] } }): Sent[] =>
  request.mock.calls.filter(([endpoint]) => endpoint === PATCH).map(([, init]) => init as Sent);

const price = () =>
  screen.findByRole<HTMLInputElement>('textbox', { name: 'Prezzo di Barolo Bussia' });
const bottles = () =>
  screen.getByRole<HTMLInputElement>('textbox', { name: 'Bottiglie di Barolo Bussia' });
const availability = () =>
  screen.getByRole<HTMLSelectElement>('combobox', { name: 'Disponibilità di Barolo Bussia' });

const type = (input: HTMLElement, value: string) => {
  fireEvent.input(input, { target: { value } });
};

const saved = (over: Partial<Product>) => () => Promise.resolve({ ...BAROLO, ...over });

describe('saving', () => {
  it('saves a typed price after a pause, as one request carrying only the price', async () => {
    const { request } = mount(saved({ priceCents: 1950 }));

    type(await price(), '19,50');
    expect(patchesOf(request)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

    await waitFor(() => {
      expect(patchesOf(request)).toEqual([{ params: { id: 'a' }, body: { priceCents: 1950 } }]);
    });
    await waitFor(async () => {
      expect((await price()).value).toBe('19,50');
    });
  });

  it('waits for typing to pause, rather than saving every keystroke', async () => {
    const { request } = mount(saved({ priceCents: 1950 }));
    const input = await price();

    type(input, '19');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS / 2);
    type(input, '19,50');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS / 2);

    // A full pause has passed since the first keystroke, but not since the last.
    expect(patchesOf(request)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await waitFor(() => {
      expect(patchesOf(request)).toEqual([{ params: { id: 'a' }, body: { priceCents: 1950 } }]);
    });
  });

  it('batches availability and bottles edited together into one request', async () => {
    const { request } = mount(saved({ stockStatus: 'OUT_OF_STOCK', stockQty: 0 }));
    await price();

    fireEvent.change(availability(), { target: { value: 'OUT_OF_STOCK' } });
    type(bottles(), '0');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

    await waitFor(() => {
      expect(patchesOf(request)).toEqual([
        { params: { id: 'a' }, body: { stockStatus: 'OUT_OF_STOCK', stockQty: 0 } },
      ]);
    });
  });

  it('saves at once when the cell loses focus', async () => {
    const { request } = mount(saved({ priceCents: 1950 }));
    const input = await price();

    type(input, '19,50');
    fireEvent.blur(input);

    await waitFor(
      () => {
        expect(patchesOf(request)).toHaveLength(1);
      },
      { timeout: SAVE_DELAY_MS / 2 },
    );
  });

  it('sends nothing when a cell loses focus with nothing typed', async () => {
    const { request } = mount(saved({}));

    fireEvent.blur(await price());
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);

    expect(patchesOf(request)).toHaveLength(0);
  });

  it('sends nothing when the value typed is the one already saved', async () => {
    const { request } = mount(saved({}));

    type(await price(), '25,00');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);

    expect(patchesOf(request)).toHaveLength(0);
  });

  it('clears a bottle count to "not counted", never to zero', async () => {
    const { request } = mount(saved({ stockQty: null }));
    await price();

    type(bottles(), '');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

    await waitFor(() => {
      expect(patchesOf(request)).toEqual([{ params: { id: 'a' }, body: { stockQty: null } }]);
    });
  });

  it('saves what is waiting when the screen goes away', async () => {
    const { request, unmount } = mount(saved({ priceCents: 1950 }));

    type(await price(), '19,50');
    unmount();

    expect(patchesOf(request)).toEqual([{ params: { id: 'a' }, body: { priceCents: 1950 } }]);
  });
});

describe('what is refused', () => {
  it('refuses an ambiguous price where it was typed, and sends nothing', async () => {
    const { request } = mount(saved({}));
    const input = await price();

    type(input, '1.234');

    expect(await screen.findByText(PRICE_MESSAGES.ambiguous)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');

    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(patchesOf(request)).toHaveLength(0);
  });

  it('still saves the valid cell beside an invalid one', async () => {
    const { request } = mount(saved({ stockQty: 6 }));
    const input = await price();

    type(input, 'dodici');
    type(bottles(), '6');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

    await waitFor(() => {
      expect(patchesOf(request)).toEqual([{ params: { id: 'a' }, body: { stockQty: 6 } }]);
    });
    // The invalid text stays where the seller can fix it.
    expect(input.value).toBe('dodici');
  });
});

describe('failure', () => {
  it('puts the saved value back and says the change was not saved', async () => {
    mount(() => Promise.reject(new ApiError(500, 'internal', 'boom', 'req_edit')));
    const input = await price();

    type(input, '19,50');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

    await waitFor(() => {
      expect(input.value).toBe('25,00');
    });
    const message = screen.getByText(/Modifica non salvata/);
    expect(message.textContent).toContain('req_edit');
    expect(message.textContent).not.toContain('boom');
  });

  it('clears that message once the seller edits the cell again', async () => {
    mount(() => Promise.reject(new TypeError('Failed to fetch')));
    const input = await price();

    type(input, '19,50');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await screen.findByText(/Modifica non salvata/);

    type(input, '19,90');

    expect(screen.queryByText(/Modifica non salvata/)).toBeNull();
  });
});

describe('concurrent edits', () => {
  it('keeps what the seller typed while an earlier save is in flight, then saves it', async () => {
    let release: (value: unknown) => void = () => undefined;
    let calls = 0;

    const { request } = mount(() => {
      calls += 1;
      return calls === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ ...BAROLO, priceCents: 3000 });
    });
    const input = await price();

    type(input, '19,50');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await waitFor(() => {
      expect(patchesOf(request)).toHaveLength(1);
    });

    type(input, '30,00');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

    // Never two saves for one wine at once: they could land in either order.
    expect(patchesOf(request)).toHaveLength(1);

    release({ ...BAROLO, priceCents: 1950 });

    await waitFor(() => {
      expect(patchesOf(request)).toHaveLength(2);
    });
    expect(patchesOf(request)[1]).toEqual({ params: { id: 'a' }, body: { priceCents: 3000 } });
    expect(input.value).toBe('30,00');
  });
});

describe('rows the server does not have', () => {
  it('renders a draft row as text, with nothing to edit', () => {
    const Probe = () => {
      const editor = useInlineEdit({
        client: fakeClient({}).client,
        onSaved: vi.fn(),
      });
      const columns = inlineEditColumns(editor);

      return (
        <CatalogGrid
          rows={[{ id: 'd', data: BAROLO, state: 'draft' }]}
          columns={[columns.priceCents, columns.stockStatus, columns.stockQty]}
        />
      );
    };

    render(<Probe />);

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('25,00')).toBeTruthy();
    expect(screen.getByText('Disponibile')).toBeTruthy();
  });
});

describe('parseInline', () => {
  it.each([
    ['priceCents', '12,50', { ok: true, changes: { priceCents: 1250 } }],
    ['priceCents', '12.50', { ok: true, changes: { priceCents: 1250 } }],
    ['priceCents', '1.234', { ok: false, message: PRICE_MESSAGES.ambiguous }],
    ['stockQty', ' 12 ', { ok: true, changes: { stockQty: 12 } }],
    ['stockQty', '', { ok: true, changes: { stockQty: null } }],
    ['stockQty', '-1', { ok: false }],
    ['stockQty', '1.000', { ok: false }],
    ['stockQty', '2,5', { ok: false }],
    ['stockStatus', 'PREORDER', { ok: true, changes: { stockStatus: 'PREORDER' } }],
    ['stockStatus', 'SOLD', { ok: false }],
  ] as const)('%s %j', (field, raw, expected) => {
    expect(parseInline(field, raw)).toMatchObject(expected);
  });
});

describe('changesFrom', () => {
  it('carries only inline fields, and only the ones that changed', () => {
    const { changes, sent } = changesFrom(BAROLO, {
      priceCents: '25,00',
      stockStatus: 'PREORDER',
      stockQty: 'molte',
    });

    expect(changes).toEqual({ stockStatus: 'PREORDER' });
    expect(sent).toEqual(['stockStatus']);
    for (const key of Object.keys(changes)) {
      expect(INLINE_EDIT_FIELDS as readonly string[]).toContain(key);
    }
  });
});
