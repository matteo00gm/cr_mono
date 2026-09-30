/**
 * Stripe's request encoding (P5-01, P5-02).
 *
 * Stripe's v1 API takes `application/x-www-form-urlencoded` bodies with
 * bracketed keys: an object nests as `a[b]=…`, an array as `a[0]=…`. One
 * encoder for every caller — the setup script and the API's client — because
 * two hand-rolled copies disagree exactly where a mistake is silent: Stripe
 * ignores a parameter it does not recognise in some places and applies a
 * default instead, so a mis-encoded `line_items` or `metadata` can produce a
 * session that looks fine and is wrong.
 *
 * Pure, so it lives in core; the network is the caller's.
 */

export type StripeValue = string | number | boolean | readonly StripeValue[] | StripeParams;

export interface StripeParams {
  readonly [key: string]: StripeValue | undefined;
}

/**
 * The pairs to send, in order. An `undefined` value is left out, which is how
 * an optional parameter is omitted rather than sent as the string `undefined`.
 *
 * **Arrays are indexed** (`a[0]`, `a[1]`) rather than `a[]`, because an array
 * of objects — `line_items`, `custom_fields` — has to keep each object's keys
 * together, and only an index can say which element a key belongs to.
 */
export const encodeStripeForm = (params: StripeParams, prefix = ''): [string, string][] =>
  Object.entries(params).flatMap(([name, value]): [string, string][] => {
    if (value === undefined) return [];

    const field = prefix === '' ? name : `${prefix}[${name}]`;

    if (Array.isArray(value)) {
      return (value as readonly StripeValue[]).flatMap((item, index) =>
        encodeStripeForm({ [String(index)]: item }, field),
      );
    }

    if (typeof value === 'object') return encodeStripeForm(value as StripeParams, field);

    return [[field, String(value)]];
  });
