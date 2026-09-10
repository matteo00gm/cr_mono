import {
  bandOf,
  completenessOf,
  FIELD_LABELS,
  type ScorableProduct,
} from '@catalogorosso/core/completeness';
import type { JSX } from 'preact';

/**
 * How complete a wine's description is, and what to write next (P1-13).
 *
 * **The copy explains the benefit, not the mechanism.** A seller does not care
 * that retrieval is embedding-based; they care that filling in one more field
 * means their wines get recommended more often. "Aggiungi *abbinamenti* per
 * ricevere più consigli pertinenti" is a sentence somebody acts on. "Completezza
 * 47%" on its own is a number somebody ignores.
 *
 * The score comes from `packages/core`, so the bar in the form, the column in
 * the grid and the P1-09 filter are the same function. Two implementations of
 * "how complete is this" is two numbers that disagree in front of the person
 * being asked to trust them.
 *
 * **Through the `/completeness` subpath, never the package barrel.** `core`
 * depends on `@catalogorosso/db` and Better Auth, so importing the barrel here
 * would pull `drizzle-orm` and an auth server into a browser bundle — the same
 * reason `ProductForm` validates against `api-client` rather than against the
 * table contracts. The subpath resolves to one file that imports nothing, and
 * the P0-09 boundary rule refuses the barrel outright.
 */

const BAND_LABEL = {
  sparse: 'Da completare',
  partial: 'Buono',
  rich: 'Completo',
} as const;

export interface CompletenessIndicatorProps {
  readonly product: ScorableProduct;
  /**
   * `bar` for the form, `compact` for a grid cell.
   *
   * **Same component, because the grid is where the gap is actually visible.**
   * A seller fixing one wine at a time never sees that forty of them are
   * sparse; a column does. Two components would be two places for the bands to
   * drift apart.
   */
  readonly variant?: 'bar' | 'compact' | undefined;
}

export const CompletenessIndicator = ({
  product,
  variant = 'bar',
}: CompletenessIndicatorProps): JSX.Element => {
  const { score, topSuggestion } = completenessOf(product);
  const band = bandOf(score);

  /*
   * The number, read out as a percentage rather than as a bare integer.
   *
   * A `progressbar` role without `aria-valuetext` is announced as "47" — which
   * could be anything. This is the only thing a screen-reader user gets, since
   * the bar itself is decorative.
   */
  const label = `Completezza ${String(score)}%. ${BAND_LABEL[band]}.`;

  if (variant === 'compact') {
    return (
      <span class={`cr-completeness cr-completeness--compact cr-completeness--${band}`}>
        <span
          class="cr-completeness__track"
          role="progressbar"
          aria-valuenow={score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={label}
        >
          <span class="cr-completeness__fill" style={{ width: `${String(score)}%` }} />
        </span>
        <span class="cr-completeness__score">{`${String(score)}%`}</span>
      </span>
    );
  }

  return (
    <div class={`cr-completeness cr-completeness--${band}`}>
      <div class="cr-completeness__header">
        <span class="cr-completeness__title">Completezza scheda</span>
        <span class="cr-completeness__score">{`${String(score)}%`}</span>
      </div>

      <div
        class="cr-completeness__track"
        role="progressbar"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={label}
      >
        <span class="cr-completeness__fill" style={{ width: `${String(score)}%` }} />
      </div>

      {/*
       * One suggestion, named. A list of nine is a list nobody starts, and
       * "completa la scheda" is advice with no next action in it.
       *
       * `aria-live="polite"` because this changes as the seller types: without
       * it a screen-reader user fills in the pairings field and is told nothing
       * happened. Polite rather than assertive — it must not interrupt the
       * field they are still in.
       */}
      <p class="cr-completeness__hint" aria-live="polite">
        {topSuggestion === undefined ? (
          'Scheda completa. Questo vino ha tutto quello che serve per essere consigliato bene.'
        ) : (
          <>
            {'Aggiungi '}
            <strong>{FIELD_LABELS[topSuggestion]}</strong>
            {' per ricevere più consigli pertinenti.'}
          </>
        )}
      </p>
    </div>
  );
};
