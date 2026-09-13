import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { CatalogGrid, type GridColumn, type GridRow } from './CatalogGrid.js';
import {
  draftFromRaw,
  editDraft,
  summarise,
  summaryText,
  visibleErrors,
  type DraftRow,
} from './draft-rows.js';
import { COLUMN_LABEL } from './header-map.js';
import { STOCK_LABEL } from './InlineEdit.js';
import type { RawRow, TemplateField } from './template.js';

/**
 * Draft rows in the grid, every cell editable, every error where it applies
 * (P1-22).
 *
 * **Errors sit in the cell they are about.** A list of complaints under the
 * grid is a list a seller has to match back to rows; a message beside the value
 * is one they can fix without looking anywhere else. Fields the grid has no
 * column for still get their message, in a column that names the field.
 */

/**
 * The columns a draft is edited in: the four without which no wine can be
 * saved, and the two that change weekly. The rest are named in "Altri
 * problemi" when they are wrong, and edited after import in the form.
 */
export const DRAFT_COLUMNS: readonly TemplateField[] = [
  'name',
  'sku',
  'wineType',
  'price',
  'stockStatus',
  'stockQty',
];

const STOCK_STATUSES = Object.keys(STOCK_LABEL) as (keyof typeof STOCK_LABEL)[];

type Edit = (id: string, field: TemplateField, text: string) => void;

const editableColumn = (field: TemplateField, onEdit: Edit): GridColumn<DraftRow> => ({
  key: field,
  header: COLUMN_LABEL[field].charAt(0).toUpperCase() + COLUMN_LABEL[field].slice(1),
  numeric: field === 'price' || field === 'stockQty',
  cell: (row) => {
    const label = `${COLUMN_LABEL[field]}, riga ${String(row.data.position)}`;
    const invalid = row.data.errors[field] === undefined ? undefined : 'true';

    if (field === 'stockStatus') {
      return (
        <select
          class="cr-inline__input"
          aria-label={label}
          aria-invalid={invalid}
          value={row.data.stockStatusUnrecognised ? '' : row.data.values.stockStatus}
          onChange={(event) => {
            onEdit(row.id, field, event.currentTarget.value);
          }}
        >
          {row.data.stockStatusUnrecognised && <option value="">—</option>}
          {STOCK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STOCK_LABEL[status]}
            </option>
          ))}
        </select>
      );
    }

    return (
      <input
        class={`cr-inline__input${field === 'price' || field === 'stockQty' ? ' cr-inline__input--numeric' : ''}`}
        aria-label={label}
        aria-invalid={invalid}
        value={row.data.values[field]}
        onInput={(event) => {
          onEdit(row.id, field, event.currentTarget.value);
        }}
      />
    );
  },
});

export interface DraftGridProps {
  readonly rows: readonly DraftRow[];
  readonly onEdit: Edit;
}

export const DraftGrid = ({ rows, onEdit }: DraftGridProps): JSX.Element => {
  const gridRows = rows.map((row): GridRow<DraftRow> => ({
    id: row.id,
    data: row,
    state: row.payload === undefined ? 'error' : 'draft',
    errors: visibleErrors(row, DRAFT_COLUMNS).inCells,
  }));

  const columns: readonly GridColumn<DraftRow>[] = [
    {
      key: 'position',
      header: 'N.',
      width: '3.5rem',
      numeric: true,
      cell: (row) => row.data.position,
    },
    ...DRAFT_COLUMNS.map((field) => editableColumn(field, onEdit)),
    {
      key: 'problems',
      header: 'Altri problemi',
      width: '18rem',
      cell: (row) => {
        const { elsewhere, more } = visibleErrors(row.data, DRAFT_COLUMNS);
        const parts = [...elsewhere, ...(more === 0 ? [] : [`+${String(more)} altri`])];
        return parts.length === 0 ? null : <span class="cr-grid__error">{parts.join(' · ')}</span>;
      },
    },
  ];

  return (
    <div class="cr-drafts">
      {/*
       * A live region, because fixing a cell changes it and a seller working
       * with a screen reader otherwise hears nothing to say the row is now
       * valid. Polite: it must not interrupt the cell they are still typing in.
       */}
      <p class="cr-drafts__summary" role="status" aria-live="polite">
        {summaryText(summarise(rows))}
      </p>
      <CatalogGrid rows={gridRows} columns={columns} empty="Nessuna riga da importare." />
    </div>
  );
};

/**
 * Draft rows as state: built once from raw rows, edited a cell at a time.
 *
 * Validation runs on every edit, which is cheap — `buildPayload` over one row —
 * and is what lets a fixed cell clear its message as the seller types.
 */
export const useDrafts = (
  raw: readonly RawRow[],
): { readonly rows: readonly DraftRow[]; readonly edit: Edit } => {
  const [rows, setRows] = useState<readonly DraftRow[]>(() =>
    raw.map((row, index) => draftFromRaw(row, index + 1)),
  );

  return {
    rows,
    edit: (id, field, text) => {
      setRows((current) =>
        current.map((row) => (row.id === id ? editDraft(row, field, text) : row)),
      );
    },
  };
};
