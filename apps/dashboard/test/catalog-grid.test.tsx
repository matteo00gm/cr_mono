import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompletenessIndicator } from '../src/features/catalog/CompletenessIndicator.js';
import {
  CatalogGrid,
  ROW_HEIGHT,
  windowFor,
  type GridColumn,
  type GridRow,
} from '../src/features/catalog/CatalogGrid.js';

/**
 * The catalogue grid (P1-10).
 *
 * **Two things here are worth more than the rest.** That five thousand rows do
 * not mount five thousand nodes is the row's own acceptance test — and the
 * reason it matters is not the frame rate, it is that the alternative is a
 * screen a seller with a real catalogue cannot open at all.
 *
 * The second is that virtualisation does not lie about the table's size. Only a
 * slice is in the DOM, so assistive technology would otherwise announce "row 3
 * of 12" for five thousand wines — a table that is navigable by eye and
 * unusable by anything else, with nothing on screen to suggest it.
 */

afterEach(cleanup);

interface Wine {
  readonly name: string;
  readonly priceCents: number;
}

const COLUMNS: readonly GridColumn<Wine>[] = [
  { key: 'name', header: 'Nome', cell: (row) => row.data.name },
  {
    key: 'priceCents',
    header: 'Prezzo',
    numeric: true,
    cell: (row) => (row.data.priceCents / 100).toFixed(2),
  },
];

const rows = (count: number, over: Partial<GridRow<Wine>> = {}): GridRow<Wine>[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `w${String(index)}`,
    data: { name: `Vino ${String(index)}`, priceCents: 1000 + index },
    state: 'saved' as const,
    ...over,
  }));

describe('the window', () => {
  it('renders far fewer nodes than there are rows', () => {
    /*
     * **The row's acceptance test, and the reason it exists is not smoothness.**
     * Five thousand rows is a real catalogue; mounting five thousand of
     * anything is a screen that takes seconds to open and then janks on every
     * keystroke. The assertion is deliberately loose — the exact count depends
     * on the viewport and the overscan — because pinning it would make every
     * change to either a failing test about nothing.
     */
    render(<CatalogGrid rows={rows(5000)} columns={COLUMNS} height={480} />);

    const rendered = screen.getAllByRole('row').length;

    expect(rendered).toBeLessThan(60);
    expect(rendered).toBeGreaterThan(5);
  });

  it('tells assistive technology the real size, not the rendered one', () => {
    /*
     * **Virtualisation's silent cost.** Without `aria-rowcount` a screen reader
     * announces the slice: "row 3 of 12" for a catalogue of five thousand. The
     * table looks perfect and is unusable by anyone not looking at it, and
     * nothing on the page hints at it.
     */
    render(<CatalogGrid rows={rows(5000)} columns={COLUMNS} />);

    // 5,000 data rows plus the header, which counts in the grid's numbering.
    expect(screen.getByRole('grid').getAttribute('aria-rowcount')).toBe('5001');
  });

  it('numbers each rendered row by its real position', () => {
    /*
     * The other half. A correct total with rendered rows numbered 1..12 is
     * still a table that cannot be navigated: "go to row 4000" lands nowhere.
     */
    render(<CatalogGrid rows={rows(50)} columns={COLUMNS} height={200} />);

    const indexes = screen
      .getAllByRole('row')
      .map((row) => row.getAttribute('aria-rowindex'))
      .filter((value): value is string => value !== null);

    // Header is row 1, so data starts at 2 and runs consecutively.
    expect(indexes[0]).toBe('2');
    expect(indexes.map(Number)).toEqual(indexes.map((_, i) => Number(indexes[0]) + i));
  });

  it('moves the window as the viewport scrolls', () => {
    const { container } = render(<CatalogGrid rows={rows(1000)} columns={COLUMNS} height={200} />);

    expect(screen.queryByText('Vino 500')).toBeNull();

    const viewport = container.querySelector('.cr-grid__viewport');
    if (viewport === null) throw new Error('no viewport');

    Object.defineProperty(viewport, 'scrollTop', { value: 500 * ROW_HEIGHT, writable: true });
    fireEvent.scroll(viewport);

    expect(screen.getByText('Vino 500')).toBeTruthy();
    expect(screen.queryByText('Vino 0')).toBeNull();
  });
});

describe('windowFor', () => {
  it('never starts below zero', () => {
    // A scroll of zero minus the overscan is negative, and `slice(-6)` returns
    // the *last* six rows — the top of a catalogue showing its bottom.
    expect(windowFor(0, 480, 1000).start).toBe(0);
  });

  it('never runs past the end', () => {
    const total = 20;

    expect(windowFor(total * ROW_HEIGHT, 480, total).end).toBe(total);
  });

  it('covers a viewport boundary that falls inside a row', () => {
    /*
     * The off-by-one that shows as a half-painted row at the bottom edge, then
     * blank space. Asserted as a property rather than a number: the window has
     * to reach past the last pixel of the viewport.
     */
    const { start, end } = windowFor(0, ROW_HEIGHT * 10 + 1, 1000);

    expect((end - start) * ROW_HEIGHT).toBeGreaterThan(ROW_HEIGHT * 10 + 1);
  });

  it('keeps rows mounted either side of the viewport', () => {
    // Without an overscan a fast scroll paints blank for a frame.
    const { start } = windowFor(ROW_HEIGHT * 100, 480, 1000);

    expect(start).toBeLessThan(100);
  });
});

describe('the row states, which exist for screens that do not exist yet', () => {
  it('marks a draft row as unsaved', () => {
    /*
     * **Built before anything produces one, deliberately.** The paste handler
     * (P1-14) and import review (P1-22) both show rows that are not yet written
     * beside rows that are — and retrofitting that means changing the row type,
     * every cell renderer and every test at once.
     */
    const { container } = render(
      <CatalogGrid rows={rows(1, { state: 'draft' })} columns={COLUMNS} />,
    );

    expect(container.querySelector('.cr-grid__row--draft')).toBeTruthy();
  });

  it('renders an error message in the cell it belongs to, not at the end of the row', () => {
    /*
     * The row's other requirement, and the difference between a review somebody
     * can act on and a list of complaints. "3 errors" at the end of a line is a
     * row that has to be opened; the message beside the value is one that can
     * be fixed in place.
     */
    const { container } = render(
      <CatalogGrid
        rows={rows(1, { state: 'error', errors: { priceCents: 'Prezzo non valido' } })}
        columns={COLUMNS}
      />,
    );

    const cells = [...container.querySelectorAll('.cr-grid__cell')];
    const flagged = cells.filter((cell) => cell.classList.contains('cr-grid__cell--error'));

    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.textContent).toContain('Prezzo non valido');
    // And the other cell is untouched, rather than the whole row being red.
    expect(container.querySelector('.cr-grid__cell:not(.cr-grid__cell--error)')).toBeTruthy();
  });

  it('leaves a saved row unmarked', () => {
    const { container } = render(<CatalogGrid rows={rows(1)} columns={COLUMNS} />);

    expect(container.querySelector('.cr-grid__row--saved')).toBeTruthy();
    expect(container.querySelector('.cr-grid__row--error')).toBeNull();
  });
});

describe('selection', () => {
  it('reports what was chosen without owning the state', () => {
    /*
     * Controlled, because the actions that act on a selection — bulk reindex
     * (P1-39), bulk archive — live above the grid. A grid holding its own
     * selection would make "what is selected" two answers.
     */
    const onSelectionChange = vi.fn();

    render(
      <CatalogGrid
        rows={rows(3)}
        columns={COLUMNS}
        selected={new Set()}
        onSelectionChange={onSelectionChange}
      />,
    );

    const second = screen.getAllByRole('checkbox')[1];
    if (second === undefined) throw new Error('expected three checkboxes');

    fireEvent.click(second);

    expect([...(onSelectionChange.mock.calls[0]?.[0] as Set<string>)]).toEqual(['w1']);
  });

  it('shows no checkboxes when nothing can act on a selection', () => {
    // A control that does nothing is worse than an absent one: it invites a
    // seller to select rows and then offers them nothing to do.
    render(<CatalogGrid rows={rows(3)} columns={COLUMNS} />);

    expect(screen.queryAllByRole('checkbox')).toEqual([]);
  });

  it('labels each checkbox by its real row number', () => {
    // "Seleziona la riga 4000" rather than "Seleziona la riga 3", which is what
    // a screen reader would otherwise be told about the fourth rendered node.
    render(
      <CatalogGrid
        rows={rows(1000)}
        columns={COLUMNS}
        height={200}
        selected={new Set()}
        onSelectionChange={() => undefined}
      />,
    );

    expect(screen.getByLabelText('Seleziona la riga 1')).toBeTruthy();
  });
});

describe('an empty catalogue', () => {
  it('says so rather than rendering an empty table', () => {
    render(<CatalogGrid rows={[]} columns={COLUMNS} />);

    expect(screen.getByRole('status').textContent).toContain('Nessun vino');
    expect(screen.queryByRole('grid')).toBeNull();
  });
});

describe('the completeness column', () => {
  it('renders the compact indicator per row', () => {
    /*
     * **The home the compact variant was built for (P1-13).** A seller fixing
     * one wine at a time never sees that forty of them are sparse; a column
     * does. This is also what keeps the two variants honest — the same
     * component, so the bands cannot drift between the form and the grid.
     */
    const columns: readonly GridColumn<Wine>[] = [
      ...COLUMNS,
      {
        key: 'completeness',
        header: 'Completezza',
        width: '8rem',
        cell: () => (
          <CompletenessIndicator product={{ foodPairings: 'brasato' }} variant="compact" />
        ),
      },
    ];

    render(<CatalogGrid rows={rows(2)} columns={columns} height={200} />);

    const bars = screen.getAllByRole('progressbar');

    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute('aria-valuetext')).toMatch(/Completezza \d+%/);
  });
});
