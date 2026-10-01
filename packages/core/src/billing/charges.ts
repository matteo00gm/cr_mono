import { z } from 'zod';

import type { TaxDetails } from './tax-details.js';

/**
 * The charges a FatturaPA may be owed for (P5-03a): every subscription invoice
 * Stripe reports paid, and every message top-up (P5-11a).
 *
 * **Recorded for every winery, decided at sending.** Whether a charge needs an
 * electronic invoice depends on the winery's invoice details (P5-02a), and
 * those can arrive *after* the payment — Stripe sends `invoice.paid` and
 * `checkout.session.completed` in either order. A charge skipped because the
 * details were not there yet is an invoice nobody issues; recording all of them
 * and asking at sending time cannot miss one.
 */

export type ChargeSource = 'invoice' | 'top_up';

export interface PaidCharge {
  /** `in_…` for an invoice, the payment intent for a top-up: one charge, one row. */
  readonly stripeObjectId: string;
  readonly source: ChargeSource;
  readonly customerId: string;
  /** What was paid, in minor units, as Stripe charged it. */
  readonly amountCents: number;
  /** Lowercase, as Stripe writes it. */
  readonly currency: string;
  readonly paidAt: Date;
  readonly livemode: boolean;
}

const envelope = z.object({
  type: z.string(),
  created: z.number().int().nonnegative(),
  livemode: z.boolean(),
  data: z.object({ object: z.unknown() }),
});

const paidInvoice = z.object({
  id: z.string().min(1),
  customer: z.string().min(1),
  amount_paid: z.number().int().nonnegative(),
  currency: z.string().min(1),
  status_transitions: z.object({ paid_at: z.number().int().nullish() }).nullish(),
});

/**
 * A paid invoice, as a charge — or `undefined` for anything else.
 *
 * **Both of Stripe's names for it**: a successful payment sends `invoice.paid`
 * and `invoice.payment_succeeded`, and both are read; the invoice's id makes
 * them one row. **Nothing for an invoice of nought** — a trial's, or one a
 * credit covered — because there is no payment to invoice.
 */
export const readPaidInvoice = (payload: unknown): PaidCharge | undefined => {
  const outer = envelope.safeParse(payload);

  if (!outer.success) return undefined;

  const { type, created, livemode, data } = outer.data;

  if (type !== 'invoice.paid' && type !== 'invoice.payment_succeeded') return undefined;

  const parsed = paidInvoice.safeParse(data.object);

  if (!parsed.success || parsed.data.amount_paid === 0) return undefined;

  const paidAt = parsed.data.status_transitions?.paid_at ?? created;

  return {
    stripeObjectId: parsed.data.id,
    source: 'invoice',
    customerId: parsed.data.customer,
    amountCents: parsed.data.amount_paid,
    currency: parsed.data.currency.toLowerCase(),
    paidAt: new Date(paidAt * 1000),
    livemode,
  };
};

/**
 * Whether a winery's details call for a FatturaPA through SdI: who it is, and
 * where to deliver — a Codice Destinatario, or a PEC. Anything less gets a
 * receipt, as every winery outside Italy does.
 */
export const needsEInvoice = (details: TaxDetails): boolean =>
  details.vatId !== null && (details.sdiCode !== null || details.pecAddress !== null);
