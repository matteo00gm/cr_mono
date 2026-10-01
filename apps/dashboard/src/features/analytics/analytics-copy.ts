import type { FunnelResponse } from '@catalogorosso/api-client';

/**
 * The words the analytics screen uses (P6-02, §2.4).
 *
 * **The last stage is an add to cart, and says so.** Until the Shopify webhook
 * is connected (P6-07) an order happens on the seller's checkout, out of our
 * sight, and §2.4 is explicit: *"Aggiunte al carrello"*, never *"Vendite"*.
 * A number labelled as a sale that the seller's own order list contradicts is
 * how a dashboard stops being believed.
 */

export type FunnelStage = FunnelResponse['stages'][number]['stage'];

export const STAGE_LABELS: Readonly<Record<FunnelStage, string>> = {
  WIDGET_OPEN: 'Aperture del sommelier',
  MESSAGE_SENT: 'Domande',
  RECOMMENDATION_SHOWN: 'Consigli mostrati',
  ADD_TO_CART: 'Aggiunte al carrello',
};

/** `1.230`: the Italian grouping, four digits included. */
export const count = (n: number): string =>
  new Intl.NumberFormat('it-IT', { useGrouping: 'always' }).format(n);

/** `42,5%`: a share as an Italian reads one, to a tenth at most. */
export const percent = (rate: number): string =>
  new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: 1 }).format(rate);

/** `2 settembre 2026`, read in UTC like the range itself. */
export const day = (iso: string): string =>
  new Intl.DateTimeFormat('it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00.000Z`));

/** The ranges a seller picks from, in days, today included. */
export const RANGE_CHOICES = [7, 30, 90] as const;

export type RangeChoice = (typeof RANGE_CHOICES)[number];

/** The thirty days the API reads when nobody picks (core's `DEFAULT_RANGE_DAYS`). */
export const DEFAULT_CHOICE: RangeChoice = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The `from` and `to` a choice asks for: whole UTC days ending today, because
 * that is how the API counts a day (P6-02) — a range picked in the seller's
 * own timezone would start a few hours off the one the numbers come from.
 */
export const rangeOf = (
  days: RangeChoice,
  now: Date = new Date(),
): { readonly from: string; readonly to: string } => ({
  from: new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10),
  to: now.toISOString().slice(0, 10),
});
