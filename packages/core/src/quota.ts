import { quotaStateOf, type QuotaState } from '@catalogorosso/security';

/**
 * The monthly plan cap, enforced ahead of any spend (P2-36, §3.6).
 *
 * **This is the actual cost gate.** The per-minute limits (P2-04) protect the
 * infrastructure from a burst; this is the only thing standing between a
 * runaway tenant and an unbounded bill, because a tenant answering ten thousand
 * questions a month at a steady rate never trips a per-minute anything.
 *
 * **It runs before retrieval and before generation**, which is the whole point:
 * a check after the model call has already spent the money it exists to save.
 *
 * **Messages, not tokens.** That is the unit a seller understands and the unit
 * the plan advertises — a cap in tokens is a cap nobody can predict from their
 * own behaviour, and a seller who cannot predict a cap will read hitting it as
 * a fault.
 */

/**
 * How far past the plan cap a tenant may still be served.
 *
 * **Nought at launch, and configurable rather than fixed**, because the choice
 * is commercial and not technical. Serving past the cap means billing for it,
 * and there is no overage billing until P5 — so an allowance now would be
 * generosity nobody agreed to, in a currency that is our margin.
 */
export const OVERAGE_ALLOWANCE = 0;

export interface QuotaQuestion {
  /** Messages this tenant has already been metered for this period (P2-31). */
  readonly used: number;
  /** The plan's monthly allowance (P2-04's `messagesPerMonth`). */
  readonly limit: number;
  /** How far past the cap this tenant may still go. */
  readonly overage?: number | undefined;
}

export interface QuotaDecision {
  /** Whether the message may be answered at all. */
  readonly allowed: boolean;
  /**
   * What the widget is told (§1.3).
   *
   * Three states and never a number: `/v1/widget/config` is world-readable and
   * edge-cached, so a remaining count would let a competitor read a shop's
   * traffic off its own widget.
   */
  readonly state: QuotaState;
  /**
   * Serving past the plan cap, inside the allowance.
   *
   * What §2.3's banner is driven by, and what a notification keys off. It is a
   * different fact from `allowed`: a tenant in overage is being served *and*
   * needs telling, and collapsing the two is how a seller first learns about
   * their overage from an invoice.
   */
  readonly inOverage: boolean;
  readonly used: number;
  readonly limit: number;
}

/**
 * Whether one more message may be answered.
 *
 * **`used < limit`, not `<=`.** The allowance is a count of messages, so a
 * tenant who has sent exactly their cap has had all of them: the next one is
 * the one over. Off by one here is a free month at every plan tier.
 */
export const checkQuota = ({
  used,
  limit,
  overage = OVERAGE_ALLOWANCE,
}: QuotaQuestion): QuotaDecision => ({
  allowed: used < limit + overage,
  state: quotaStateOf(used, limit),
  inOverage: used >= limit,
  used,
  limit,
});

/**
 * What a refused visitor is told.
 *
 * **A `DomainError`'s message reaches the caller verbatim (P0-55), so this one
 * says nothing about the plan.** Not which plan, not the cap, not how much is
 * left: §1.3 keeps billing details away from a visitor, and "the shop is busy"
 * is both true and the seller's business rather than the shopper's.
 */
export const QUOTA_EXCEEDED_MESSAGE =
  'This shop has reached its message limit for the month. Please come back next month, ' +
  'or contact the shop directly.';
