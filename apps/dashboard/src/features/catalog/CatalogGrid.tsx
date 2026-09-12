import { useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

/**
 * The catalogue table (P1-10).
 *
 * **Its row model is built for three screens, not one**, which is why draft and
 * error states exist before anything produces them. This grid is also the
 * substrate for the paste handler (P1-14) and for import review (P1-22), and
 * both show rows that are *not yet saved* and rows that *failed validation*
 * beside ones that are fine. Retrofitting those later means changing the row
 * type, every cell renderer and every test at once — so the shape is right now
 * and the states are simply unused until something produces them.
 */

/** Field name to message, matching the form's `FieldErrors` (P1-01). */
export type RowErrors = Readonly<Record<string, string>>;

export interface GridRow<T> {
  readonly id: string;
  readonly data: T;
  /**
   * `saved` is a row the server has; `draft` is one pasted or imported and not
   * yet written; `error` is one that will not be written until it is fixed.
   */
  readonly state: 'saved' | 'draft' | 'error';
  readonly errors?: RowErrors | undefined;
}

export interface GridColumn<T> {
  readonly key: string;
  readonly header: string;
  /** Rendered into the cell. Given the row so a cell can show its own error. */
  readonly cell: (row: GridRow<T>) => JSX.Element | string | number | null;
  /** CSS width, e.g. `'8rem'`. Fixed widths keep the header aligned. */
  readonly width?: string | undefined;
  /** Right-aligned for numbers, which is what makes a price column readable. */
  readonly numeric?: boolean | undefined;
}

/**
 * How tall one row is, in pixels.
 *
 * **A fixed height is what makes the arithmetic possible at all.** Measuring
 * each row would mean rendering it first, which is the thing virtualisation
 * exists to avoid. The cost is that a cell cannot wrap onto a second line — so
 * cells truncate, and the full value belongs in the editor rather than the
 * grid.
 */
export const ROW_HEIGHT = 40;

/**
 * Rows rendered above and below the viewport.
 *
 * Without an overscan a fast scroll paints blank space for a frame before the
 * new rows mount. Six is roughly a quarter-screen at this row height, which is
 * more than one frame's worth of travel at any speed a mouse wheel produces.
 */
const OVERSCAN = 6;

export interface CatalogGridProps<T> {
  readonly rows: readonly GridRow<T>[];
  readonly columns: readonly GridColumn<T>[];
  /** Viewport height in pixels. The window is computed against it. */
  readonly height?: number | undefined;
  readonly selected?: ReadonlySet<string> | undefined;
  readonly onSelectionChange?: ((selected: ReadonlySet<string>) => void) | undefined;
  /** Shown instead of the table when there are no rows at all. */
  readonly empty?: string | undefined;
}

/**
 * Which slice of the rows is on screen.
 *
 * Exported and pure so the arithmetic can be tested without a DOM — the part
 * that is easy to get subtly wrong is the window, not the markup, and an
 * off-by-one here hides a row from a seller rather than crashing.
 */
export const windowFor = (
  scrollTop: number,
  height: number,
  total: number,
): { start: number; end: number } => {
  const first = Math.floor(scrollTop / ROW_HEIGHT);
  const visible = Math.ceil(height / ROW_HEIGHT);

  return {
    start: Math.max(0, first - OVERSCAN),
    // `+ 1` because a viewport boundary falling inside a row still shows part
    // of it; without it the last row is half-painted and then blank.
    end: Math.min(total, first + visible + OVERSCAN + 1),
  };
};

/**
 * Hand-rolled rather than `@tanstack/virtual`, which the row offers as an
 * option.
 *
 * Fixed-height windowing is about forty lines, and the library is a dependency
 * whose surface is mostly the cases this grid does not have: variable heights,
 * horizontal virtualisation, dynamic measurement. The plan's own note — "a few
 * hundred rows do not need a library, and thousands do" — is the argument for
 * *having* virtualisation, not for importing one.
 *
 * **A virtualised table lies to a screen reader unless it is told not to.**
 * Only a slice of the rows is in the DOM, so assistive technology announces
 * "row 3 of 12" for a catalogue of five thousand. `aria-rowcount` carries the
 * real total and `aria-rowindex` carries each row's real position — and those
 * two attributes are the difference between a table somebody can navigate and
 * one that silently misreports its own size.
 */
export const CatalogGrid = <T,>({
  rows,
  columns,
  height = 480,
  selected,
  onSelectionChange,
  empty = 'Nessun vino in questo catalogo.',
}: CatalogGridProps<T>): JSX.Element => {
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);

  if (rows.length === 0) {
    return (
      <p class="cr-grid__empty" role="status">
        {empty}
      </p>
    );
  }

  const { start, end } = windowFor(scrollTop, height, rows.length);
  const visible = rows.slice(start, end);

  const selectable = onSelectionChange !== undefined;
  const chosen = selected ?? new Set<string>();

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange?.(next);
  };

  return (
    <div class="cr-grid">
      <div
        class="cr-grid__head"
        role="row"
        style={{ gridTemplateColumns: templateFor(columns, selectable) }}
      >
        {selectable && <span class="cr-grid__cell cr-grid__cell--check" role="columnheader" />}
        {columns.map((column) => (
          <span
            key={column.key}
            class={`cr-grid__cell${column.numeric === true ? ' cr-grid__cell--numeric' : ''}`}
            role="columnheader"
          >
            {column.header}
          </span>
        ))}
      </div>

      <div
        class="cr-grid__viewport"
        ref={viewport}
        style={{ height: `${String(height)}px` }}
        onScroll={(event: Event) => {
          setScrollTop((event.currentTarget as HTMLDivElement).scrollTop);
        }}
      >
        {/*
         * A spacer the full height of every row, so the scrollbar is the size
         * it would be if all of them were mounted. Without it the thumb jumps
         * as rows are swapped in and the scroll position means nothing.
         */}
        <div
          class="cr-grid__sizer"
          style={{ height: `${String(rows.length * ROW_HEIGHT)}px` }}
          role="grid"
          /*
           * The real totals, not the rendered ones. `+ 1` for the header row,
           * which counts in the grid's own numbering.
           */
          aria-rowcount={rows.length + 1}
          aria-colcount={columns.length + (selectable ? 1 : 0)}
        >
          {visible.map((row, index) => (
            <GridRowView
              key={row.id}
              row={row}
              columns={columns}
              selectable={selectable}
              checked={chosen.has(row.id)}
              onToggle={toggle}
              top={(start + index) * ROW_HEIGHT}
              /* Header is row 1, so the first data row is 2. */
              rowIndex={start + index + 2}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

const templateFor = <T,>(columns: readonly GridColumn<T>[], selectable: boolean): string =>
  [
    ...(selectable ? ['2.5rem'] : []),
    ...columns.map((column) => column.width ?? 'minmax(6rem, 1fr)'),
  ].join(' ');

const GridRowView = <T,>({
  row,
  columns,
  selectable,
  checked,
  onToggle,
  top,
  rowIndex,
}: {
  readonly row: GridRow<T>;
  readonly columns: readonly GridColumn<T>[];
  readonly selectable: boolean;
  readonly checked: boolean;
  readonly onToggle: (id: string) => void;
  readonly top: number;
  readonly rowIndex: number;
}): JSX.Element => (
  <div
    class={`cr-grid__row cr-grid__row--${row.state}`}
    role="row"
    aria-rowindex={rowIndex}
    aria-selected={selectable ? checked : undefined}
    /*
     * Absolutely positioned inside the sizer rather than laid out in flow: the
     * rendered slice starts partway down the list, and in flow it would paint
     * at the top of the viewport regardless of where the scroll is.
     */
    style={{
      transform: `translateY(${String(top)}px)`,
      gridTemplateColumns: templateFor(columns, selectable),
    }}
  >
    {selectable && (
      <span class="cr-grid__cell cr-grid__cell--check" role="gridcell">
        <input
          type="checkbox"
          checked={checked}
          aria-label={`Seleziona la riga ${String(rowIndex - 1)}`}
          onChange={() => {
            onToggle(row.id);
          }}
        />
      </span>
    )}

    {columns.map((column) => {
      const message = row.errors?.[column.key];

      return (
        <span
          key={column.key}
          class={`cr-grid__cell${column.numeric === true ? ' cr-grid__cell--numeric' : ''}${
            message === undefined ? '' : ' cr-grid__cell--error'
          }`}
          role="gridcell"
        >
          <span class="cr-grid__value">{column.cell(row)}</span>

          {/*
           * Per cell, not per row. An import review showing "3 errors" at the
           * end of a line is a row somebody has to open to act on; the message
           * beside the value is one they can read and fix in place — which is
           * the whole point of reviewing an import in a grid rather than in a
           * list of complaints.
           */}
          {message !== undefined && <span class="cr-grid__error">{message}</span>}
        </span>
      );
    })}
  </div>
);
