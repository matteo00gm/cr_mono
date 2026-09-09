import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Inbound webhook signature verification (P0-64b).
 *
 * **This is the third way into `apps/api`, and it has nothing in common with
 * the other two.** The dashboard authenticates a person by session cookie and
 * scopes them to a tenant from `memberships`; the widget authenticates a site
 * by an origin-bound token. A webhook has no person, no tenant and no origin —
 * the only thing distinguishing a real Resend delivery from a forged one is an
 * HMAC the provider computed over the bytes it sent.
 *
 * Resend signs with **Svix**, and so does a long list of other providers, so
 * this is written as Svix verification rather than as "the Resend check". P0-33
 * needs the same surface for Stripe, which signs differently (`t=…,v1=…` over
 * `t.body`); when that lands it gets its own verifier beside this one and the
 * surface stays shared. What must not happen is a second copy of the
 * comparison, the tolerance and the parsing.
 *
 * **Everything here operates on the raw body.** A signature is over bytes, so a
 * handler that verifies `JSON.stringify(await c.req.json())` verifies something
 * the provider never sent — key order, whitespace and number formatting all
 * differ — and the check either fails for every legitimate delivery or, worse,
 * is written loosely enough to pass and no longer proves anything.
 */

/**
 * Why a verification failed.
 *
 * Returned rather than thrown, and separated from the message the caller sees,
 * because the two have opposite requirements: the log wants the specific reason
 * so an operator can tell a misconfigured secret from a clock skew, and the
 * response must say only that it failed — a provider retries on any 4xx, and a
 * prober should not be handed a description of what to fix.
 */
export type SignatureFailure =
  | 'missing-headers'
  | 'malformed-timestamp'
  | 'timestamp-outside-tolerance'
  | 'no-signatures'
  | 'no-match';

export type SignatureResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: SignatureFailure };

export interface SvixHeaders {
  /** `svix-id` — the message id, and the idempotency key for a redelivery. */
  readonly id: string | undefined;
  /** `svix-timestamp` — unix seconds, as sent. */
  readonly timestamp: string | undefined;
  /** `svix-signature` — space-separated `v1,<base64>` entries. */
  readonly signature: string | undefined;
}

export interface VerifyOptions {
  /** The endpoint secret, `whsec_<base64>`, from the provider's dashboard. */
  readonly secret: string;
  readonly headers: SvixHeaders;
  /** The body exactly as received, before any parse. */
  readonly body: string;
  /** Injected so the tolerance is testable without waiting five minutes. */
  readonly now?: () => number;
}

/**
 * How far the signed timestamp may be from ours, in seconds.
 *
 * **Not decoration around the HMAC — it is what stops a replay.** Without it a
 * request captured anywhere in the path stays valid forever, because the
 * signature over it never expires. The `processed_webhooks` claim also stops a
 * replay, but only of an id already seen: a delivery captured *before* it
 * reached us replays perfectly against an empty ledger.
 *
 * Five minutes is Svix's own recommendation, and the number is a clock-skew
 * budget rather than a security tuning knob — Lambda's clock is NTP-synced and
 * the provider's is too, so the real gap is milliseconds and the margin exists
 * for the case where one of them is wrong.
 */
export const TIMESTAMP_TOLERANCE_SEC = 300;

/**
 * The bytes the secret actually is.
 *
 * `whsec_` is a display prefix and is **not** part of the key; the rest is
 * base64. Signing with the whole string produces a signature that never matches
 * and a check that fails closed — which sounds safe and is not, because the
 * symptom is every delivery being rejected and the natural fix is somebody
 * turning verification off to get the integration working.
 *
 * A secret without the prefix is accepted as base64 as-is, because that is what
 * some dashboards copy out.
 */
const secretBytes = (secret: string): Buffer =>
  Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');

/**
 * Constant-time comparison over the decoded bytes.
 *
 * The same reasoning as `requireOriginSecret` (A2), and it applies more
 * directly here: a webhook endpoint is unauthenticated by definition, so an
 * attacker can retry against it as fast as the network allows with nothing in
 * front to slow them down. `timingSafeEqual` throws on a length mismatch, so
 * the lengths are compared first and separately.
 */
const matches = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/**
 * Every `v1` signature in the header, base64-decoded.
 *
 * **A list, not a value, and that is what makes secret rotation possible.**
 * Svix sends one entry per active endpoint secret, so during a rotation two
 * arrive and either is legitimate. A verifier that read only the first would
 * work, keep working, and then reject everything on the day somebody rotates —
 * at which point the endpoint is down and the cause is invisible.
 *
 * Non-`v1` schemes are dropped rather than treated as failures: they are how a
 * future algorithm arrives, and an unknown scheme alongside a valid `v1` is a
 * delivery we can verify.
 */
const parseSignatures = (header: string): readonly Buffer[] =>
  header
    .split(' ')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => Buffer.from(entry.slice('v1,'.length), 'base64'));

export const verifySvixSignature = ({
  secret,
  headers,
  body,
  now = Date.now,
}: VerifyOptions): SignatureResult => {
  const { id, timestamp, signature } = headers;

  if (id === undefined || timestamp === undefined || signature === undefined) {
    return { ok: false, reason: 'missing-headers' };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'malformed-timestamp' };

  /*
   * Both directions, deliberately. A timestamp far in the *future* is as much a
   * sign of a forged or replayed request as an old one, and an implementation
   * that only checks the past accepts a signature good until the year 3000.
   */
  const skew = Math.abs(now() / 1000 - sentAt);
  if (skew > TIMESTAMP_TOLERANCE_SEC) return { ok: false, reason: 'timestamp-outside-tolerance' };

  const provided = parseSignatures(signature);
  if (provided.length === 0) return { ok: false, reason: 'no-signatures' };

  /*
   * The id and timestamp are inside the signed content, which is what binds
   * them to the body: without that, an attacker could take a legitimate
   * delivery and re-send it with a fresh timestamp to defeat the tolerance
   * check above, and with a fresh id to defeat the idempotency claim.
   */
  const expected = createHmac('sha256', secretBytes(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest();

  return provided.some((candidate) => matches(candidate, expected))
    ? { ok: true }
    : { ok: false, reason: 'no-match' };
};
