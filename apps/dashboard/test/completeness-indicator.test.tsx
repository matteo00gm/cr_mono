import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { CompletenessIndicator } from '../src/features/catalog/CompletenessIndicator.js';
import { emptyValues, ProductForm } from '../src/features/catalog/ProductForm.js';

/**
 * The completeness indicator (P1-13).
 *
 * **What is worth testing here is the copy and the announcement**, not the
 * arithmetic — the score is P1-12's and is tested there. What this component
 * can get wrong is telling a seller the wrong thing to do next, or telling a
 * screen-reader user nothing at all while a bar silently fills in.
 */

afterEach(cleanup);

const FULL = {
  producer: 'Poderi Colla',
  vintage: '2019',
  grapeVarieties: 'Nebbiolo',
  region: 'Piemonte',
  denomination: 'Barolo DOCG',
  styleTags: 'strutturato',
  tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
  foodPairings: 'brasato',
  alcoholPct: '14.5',
};

describe('what it tells the seller', () => {
  it('names the specific field worth adding, not "completa la scheda"', () => {
    /*
     * **The row's requirement, and the difference between advice and a task.**
     * "Completa la scheda" has no next action in it; "Aggiungi abbinamenti" is
     * something a seller does in ten seconds. The named field is the top
     * suggestion, so this is also what keeps the copy and the score agreeing.
     */
    render(<CompletenessIndicator product={{ ...FULL, foodPairings: '' }} />);

    expect(screen.getByText('abbinamenti')).toBeTruthy();
    expect(screen.getByText(/per ricevere più consigli pertinenti/)).toBeTruthy();
  });

  it('moves to the next field once that one is filled', () => {
    render(<CompletenessIndicator product={{ ...FULL, tastingNotes: '' }} />);

    expect(screen.getByText('note di degustazione')).toBeTruthy();
  });

  it('explains the benefit rather than the mechanism', () => {
    /*
     * A seller does not care that retrieval is embedding-based. The sentence
     * has to be about their wines being recommended — and it must not mention
     * embeddings, indexing or vectors, which is the direction this copy drifts
     * when an engineer edits it.
     */
    render(<CompletenessIndicator product={{ ...FULL, foodPairings: '' }} />);

    const hint = screen.getByText(/per ricevere/).textContent ?? '';

    expect(hint).toMatch(/consigli/);
    expect(hint).not.toMatch(/embedding|indic|vettor|retrieval/i);
  });

  it('says so when there is nothing left to add', () => {
    // Not silence. A bar at 100% with no sentence reads as an unfinished
    // component rather than as a finished wine.
    render(<CompletenessIndicator product={FULL} />);

    expect(screen.getByText(/Scheda completa/)).toBeTruthy();
  });
});

describe('what a screen reader gets', () => {
  it('announces the percentage in words, not a bare number', () => {
    /*
     * A `progressbar` with `aria-valuenow` alone is announced as "47", which
     * could be anything. The bar itself is decorative, so this text is the only
     * thing a screen-reader user receives.
     */
    render(<CompletenessIndicator product={{ ...FULL, foodPairings: '' }} />);

    const bar = screen.getByRole('progressbar');

    expect(bar.getAttribute('aria-valuetext')).toMatch(/Completezza \d+%/);
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('announces the band as well as the number', () => {
    // 47% means nothing without "da completare" or "buono" beside it.
    render(<CompletenessIndicator product={{}} />);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toMatch(/Da completare/);
  });

  it('re-announces politely as the seller types, rather than interrupting', () => {
    /*
     * Without a live region, somebody using a screen reader fills in the
     * pairings field and is told nothing happened. Polite rather than
     * assertive, because it must not interrupt the field they are still in.
     */
    render(<CompletenessIndicator product={{}} />);

    const hint = screen.getByText(/Aggiungi/);

    expect(hint.closest('[aria-live]')?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('the bands', () => {
  it.each([
    ['sparse', {}],
    ['partial', { foodPairings: 'brasato', tastingNotes: 'Rosa appassita.' }],
    ['rich', FULL],
  ])('carries the %s band as a class', (band, product) => {
    const { container } = render(<CompletenessIndicator product={product} />);

    expect(container.querySelector(`.cr-completeness--${band}`)).toBeTruthy();
  });

  it('never uses colour as the only signal', () => {
    /*
     * The band is a class, so it is a colour. The percentage and the band's own
     * words are always present beside it — a seller with a red-green deficiency,
     * or one who has turned colour off, reads exactly what everyone else does.
     */
    render(<CompletenessIndicator product={{}} />);

    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toContain(
      'Da completare',
    );
  });
});

describe('the compact variant', () => {
  it('keeps the number and the announcement, and drops the sentence', () => {
    /*
     * **The grid is where the gap is actually visible**: a seller fixing one
     * wine at a time never sees that forty of them are sparse, and a column
     * does. A per-row sentence would be unreadable, but a per-row number with
     * no announcement would be a column a screen-reader user cannot use.
     */
    render(<CompletenessIndicator product={{}} variant="compact" />);

    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBeTruthy();
    expect(screen.queryByText(/Aggiungi/)).toBeNull();
  });
});

describe('inside the form', () => {
  it('appears in the editor and reacts to what is typed', () => {
    /*
     * **The one thing neither the component nor the score can show alone**:
     * that the form's own values are a shape the score can read. The form keeps
     * every field as a string — arrays comma-joined — so if `completenessOf`
     * expected arrays it would score every wine at zero, in the editor, for
     * ever, and both unit suites would still pass.
     */
    render(<ProductForm initial={emptyValues()} onSubmit={() => undefined} />);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toContain('0%');

    fireEvent.input(screen.getByLabelText(/Abbinamenti/), {
      target: { value: 'brasato, formaggi stagionati' },
    });

    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).not.toContain('0%');
  });

  it('sits above the fields it is asking about', () => {
    /*
     * A bar at the bottom of the form is read after somebody has decided they
     * are finished. The score is almost entirely made of the Sommelier
     * fieldset's fields, so the prompt belongs immediately before them.
     */
    const { container } = render(
      <ProductForm initial={emptyValues()} onSubmit={() => undefined} />,
    );

    const indicator = container.querySelector('.cr-completeness');
    const sommelier = [...container.querySelectorAll('legend')].find(
      (legend) => legend.textContent === 'Sommelier',
    )?.parentElement;

    expect(indicator).toBeTruthy();
    expect(sommelier).toBeTruthy();
    expect(indicator?.compareDocumentPosition(sommelier as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
