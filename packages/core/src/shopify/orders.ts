import { z } from 'zod';

/**
 * Reading a Shopify order for what the sommelier sold (P6-07, §2.4).
 *
 * **Per line item, never per order.** The widget plants `_somm_session` on
 * each line it adds to the cart (P3-11), so a line that carries it is a wine
 * we recommended and a shopper then bought. Crediting the whole order would
 * count the two bottles they found themselves, and overstate what we are
 * worth in a way a seller will eventually notice and stop believing.
 *
 * **Only what attribution needs is read, and the rest never leaves the
 * parser.** An order's body carries a customer's name, address, email and
 * phone. None of it is in the shape below, so none of it can be stored or
 * logged by anything downstream: what comes out is ids, a quantity and an
 * amount.
 *
 * **The body is Shopify's contract, not ours**, so it is read defensively: a
 * line that cannot be read is left out rather than sinking the order, and an
 * order that cannot be read at all is `undefined`.
 */

/** The line-item property the widget plants (P3-11). The widget's `SESSION_PROPERTY` says the same. */
export const ATTRIBUTION_PROPERTY = '_somm_session';

/**
 * What a visit's id looks like: the anonymous per-tab id (P3-16), as the
 * events endpoint already holds it to (P6-01). A property is typed by
 * whoever fills the cart, so anything else is not one of ours.
 */
const VISIT = /^[A-Za-z0-9-]{8,64}$/u;

/** An amount as Shopify writes one: a decimal string, never a float. */
const DECIMAL = /^(\d{1,12})(?:\.(\d+))?$/u;

/**
 * A decimal string in hundredths of the currency's unit, rounded half up —
 * or `undefined` for anything that is not an amount.
 *
 * **Never through a float.** `0.1 + 0.2` is how a report ends up a cent out
 * from the seller's own, and a number that disagrees with Shopify's by a cent
 * is a number nobody trusts.
 */
export const hundredths = (amount: string): number | undefined => {
  const match = DECIMAL.exec(amount.trim());

  if (match === null) return undefined;

  const [, whole = '0', fraction = ''] = match;
  const padded = `${fraction}000`;
  const cents = Number(whole) * 100 + Number(padded.slice(0, 2));

  return Number(padded[2]) >= 5 ? cents + 1 : cents;
};

/**
 * An id as Shopify means it. The GraphQL id is a string and exact; the
 * numeric one is only believed while it is small enough for JSON to have
 * carried it whole — past 2^53 two different orders can arrive as one number.
 */
const idOf = (gid: unknown, numeric: unknown): string | undefined => {
  if (typeof gid === 'string' && gid !== '' && gid.length <= 128) return gid;
  if (typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric > 0) {
    return String(numeric);
  }

  return undefined;
};

const money = z.string().max(32);

const lineItem = z.object({
  id: z.unknown().optional(),
  admin_graphql_api_id: z.unknown().optional(),
  variant_id: z.unknown().optional(),
  quantity: z.number().int().min(1).max(100_000),
  price: money,
  discount_allocations: z
    .array(z.object({ amount: money }))
    .max(100)
    .optional(),
  properties: z
    .array(z.object({ name: z.unknown(), value: z.unknown() }))
    .max(100)
    .optional(),
});

const orderBody = z.object({
  id: z.unknown().optional(),
  admin_graphql_api_id: z.unknown().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  created_at: z.string().max(64).optional(),
  /** A test order — Shopify's bogus gateway — is nobody's revenue. */
  test: z.boolean().optional(),
  line_items: z.array(z.unknown()).max(1000),
});

/** One line the sommelier sold. */
export interface AttributableLine {
  readonly lineItemId: string;
  /** The visit the widget planted on the line: `_somm_session`. */
  readonly sessionId: string;
  /** Shopify's numeric variant id, as the catalogue stores it (P3-11), when the line has one. */
  readonly variantId: string | null;
  readonly quantity: number;
  /** What the shopper paid for this line, after its discounts, in hundredths. */
  readonly amountCents: number;
}

export interface AttributableOrder {
  readonly orderId: string;
  readonly currency: string;
  /** When Shopify says the order was placed, or `undefined` when it does not say. */
  readonly orderedAt: Date | undefined;
  /** Only the lines that carry a visit. Empty for an order the sommelier had no part in. */
  readonly lines: readonly AttributableLine[];
}

const visitOf = (properties: readonly { name: unknown; value: unknown }[]): string | undefined => {
  const planted = properties.find((property) => property.name === ATTRIBUTION_PROPERTY)?.value;

  return typeof planted === 'string' && VISIT.test(planted) ? planted : undefined;
};

const readLine = (raw: unknown): AttributableLine | undefined => {
  const parsed = lineItem.safeParse(raw);

  if (!parsed.success) return undefined;

  const line = parsed.data;
  const sessionId = visitOf(line.properties ?? []);
  const lineItemId = idOf(line.admin_graphql_api_id, line.id);
  const unit = hundredths(line.price);

  if (sessionId === undefined || lineItemId === undefined || unit === undefined) return undefined;

  let discounted = 0;

  for (const allocation of line.discount_allocations ?? []) {
    const amount = hundredths(allocation.amount);

    /* A discount we cannot read is one we cannot subtract, and the line would be overstated. */
    if (amount === undefined) return undefined;

    discounted += amount;
  }

  return {
    lineItemId,
    sessionId,
    variantId:
      typeof line.variant_id === 'number' &&
      Number.isSafeInteger(line.variant_id) &&
      line.variant_id > 0
        ? String(line.variant_id)
        : null,
    quantity: line.quantity,
    /* Never below nothing: a line discounted past its price was given away, not paid for. */
    amountCents: Math.max(0, unit * line.quantity - discounted),
  };
};

/**
 * The lines of an order the sommelier sold — or `undefined` when the body is
 * not an order we can read.
 *
 * Called with the raw body **after** its signature has been checked (P6-06's
 * `verifyWebhookHmac`): nothing here knows who sent it.
 */
export const readOrder = (body: string): AttributableOrder | undefined => {
  let json: unknown;

  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }

  const parsed = orderBody.safeParse(json);

  if (!parsed.success) return undefined;

  const order = parsed.data;
  const orderId = idOf(order.admin_graphql_api_id, order.id);

  if (orderId === undefined) return undefined;

  const placed = order.created_at === undefined ? Number.NaN : Date.parse(order.created_at);

  return {
    orderId,
    currency: order.currency,
    orderedAt: Number.isNaN(placed) ? undefined : new Date(placed),
    lines:
      order.test === true
        ? []
        : order.line_items.flatMap((raw) => {
            const line = readLine(raw);

            return line === undefined ? [] : [line];
          }),
  };
};

/* ------------------------------------------------------------- refunds */

const refundLine = z.object({
  id: z.unknown().optional(),
  admin_graphql_api_id: z.unknown().optional(),
  line_item_id: z.unknown().optional(),
  quantity: z.number().int().min(1).max(100_000),
  line_item: z.object({ admin_graphql_api_id: z.unknown().optional() }).optional(),
});

const refundBody = z.object({
  order_id: z.unknown().optional(),
  refund_line_items: z.array(z.unknown()).max(1000),
});

/** Units of one order line that came back. */
export interface RefundedLine {
  /** Shopify's id for this line of the refund. */
  readonly refundLineId: string;
  /** The order line it refunds, in every spelling a sale may have been written under. */
  readonly lineItemIds: readonly string[];
  readonly quantity: number;
}

export interface OrderRefund {
  /** The order, in every spelling a sale may have been written under. */
  readonly orderIds: readonly string[];
  readonly lines: readonly RefundedLine[];
}

/**
 * Every spelling of an id that a sale may have been recorded under.
 *
 * A sale is keyed by the GraphQL id when its order carried one, and by the
 * number when it did not (`idOf`). A refund names the order by number alone,
 * so the GraphQL spelling is made from it rather than read.
 */
const spellings = (kind: 'Order' | 'LineItem', numeric: unknown, gid?: unknown): string[] => {
  const ids = new Set<string>();

  if (typeof gid === 'string' && gid !== '' && gid.length <= 128) ids.add(gid);

  if (typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric > 0) {
    ids.add(`gid://shopify/${kind}/${String(numeric)}`);
    ids.add(String(numeric));
  }

  return [...ids];
};

/**
 * Which units of which lines a refund took back (P6-08) — or `undefined` when
 * the body is not a refund we can read.
 *
 * **Units, not money.** Shopify's refund carries amounts too, and they are not
 * read: what a refund takes off an attribution is worked out from what the
 * sale itself recorded, so it can never be more than was put in. A refund with
 * no line items — money handed back without a bottle — names no line, and so
 * reduces none.
 *
 * Whether a line was ours is not this function's to know; the record decides,
 * by whether a sale is there to refund. Called, like `readOrder`, only after
 * the body's signature has been checked.
 */
export const readRefund = (body: string): OrderRefund | undefined => {
  let json: unknown;

  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }

  const parsed = refundBody.safeParse(json);

  if (!parsed.success) return undefined;

  const orderIds = spellings('Order', parsed.data.order_id);

  if (orderIds.length === 0) return undefined;

  return {
    orderIds,
    lines: parsed.data.refund_line_items.flatMap((raw) => {
      const line = refundLine.safeParse(raw);

      if (!line.success) return [];

      const refundLineId = idOf(line.data.admin_graphql_api_id, line.data.id);
      const lineItemIds = spellings(
        'LineItem',
        line.data.line_item_id,
        line.data.line_item?.admin_graphql_api_id,
      );

      return refundLineId === undefined || lineItemIds.length === 0
        ? []
        : [{ refundLineId, lineItemIds, quantity: line.data.quantity }];
    }),
  };
};
