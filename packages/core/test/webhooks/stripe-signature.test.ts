import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { TIMESTAMP_TOLERANCE_SEC, verifyStripeSignature } from '../../src/webhooks/signature.js';

/**
 * Stripe signature verification (P5-03).
 *
 * **Signed the way Stripe documents it, not the way the verifier does**, for
 * the reason `signature.test.ts` gives: HMAC-SHA256 keyed with the whole
 * endpoint secret, over `t.body`, hex. A helper that borrowed the verifier's
 * internals would agree with it about a shared mistake — the prefix stripped,
 * or base64 where Stripe writes hex — and every assertion would pass.
 *
 * The secret is built at runtime (P0-56).
 */

const secretFor = () => `whsec_${randomBytes(24).toString('base64')}`;

const v1 = (secret: string, timestamp: number | string, body: string) =>
  createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');

const BODY = '{"id":"evt_1","type":"invoice.payment_failed","data":{"object":{}}}';

/** Fixed so the tolerance can be reasoned about rather than raced against. */
const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;
const now = () => NOW_MS;

const header = (secret: string, timestamp: number = NOW_S, body = BODY) =>
  `t=${String(timestamp)},v1=${v1(secret, timestamp, body)}`;

describe('verifyStripeSignature', () => {
  it('accepts an event signed with the endpoint secret', () => {
    const secret = secretFor();

    expect(verifyStripeSignature({ secret, header: header(secret), body: BODY, now })).toEqual({
      ok: true,
    });
  });

  it('refuses a body changed after signing', () => {
    const secret = secretFor();
    const tampered = BODY.replace('payment_failed', 'payment_succeeded');

    expect(verifyStripeSignature({ secret, header: header(secret), body: tampered, now })).toEqual({
      ok: false,
      reason: 'no-match',
    });
  });

  it('refuses an event signed with another secret', () => {
    expect(
      verifyStripeSignature({ secret: secretFor(), header: header(secretFor()), body: BODY, now }),
    ).toEqual({ ok: false, reason: 'no-match' });
  });

  it('keys with the whole secret, prefix included — not the base64 Svix would decode', () => {
    /*
     * Svix's secret is `whsec_` plus base64, and the key is the decoded bytes.
     * Stripe's is used as written. Signing Svix's way must fail here, or the
     * two verifiers share a mistake.
     */
    const secret = secretFor();
    const svixKey = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const svixWay = createHmac('sha256', svixKey)
      .update(`${String(NOW_S)}.${BODY}`)
      .digest('hex');

    expect(
      verifyStripeSignature({
        secret,
        header: `t=${String(NOW_S)},v1=${svixWay}`,
        body: BODY,
        now,
      }),
    ).toEqual({ ok: false, reason: 'no-match' });
  });

  it('binds the timestamp: the same signature with a fresh t does not verify', () => {
    /* Otherwise a captured event could be re-sent forever with a new `t`. */
    const secret = secretFor();
    const old = v1(secret, NOW_S - 3600, BODY);

    expect(
      verifyStripeSignature({ secret, header: `t=${String(NOW_S)},v1=${old}`, body: BODY, now }),
    ).toEqual({ ok: false, reason: 'no-match' });
  });

  it('accepts any of several v1 signatures, which is how a secret is rolled', () => {
    const secret = secretFor();
    const signed = `t=${String(NOW_S)},v1=${v1(secretFor(), NOW_S, BODY)},v1=${v1(secret, NOW_S, BODY)}`;

    expect(verifyStripeSignature({ secret, header: signed, body: BODY, now })).toEqual({
      ok: true,
    });
  });

  it('ignores v0 and schemes it does not know, rather than trusting or failing on them', () => {
    const secret = secretFor();
    const legacy = `t=${String(NOW_S)},v0=${v1(secret, NOW_S, BODY)},v9=abc`;

    expect(verifyStripeSignature({ secret, header: legacy, body: BODY, now })).toEqual({
      ok: false,
      reason: 'no-signatures',
    });
    expect(
      verifyStripeSignature({
        secret,
        header: `${legacy},v1=${v1(secret, NOW_S, BODY)}`,
        body: BODY,
        now,
      }),
    ).toEqual({ ok: true });
  });

  it('drops a v1 that is not hex, rather than decoding it into something shorter', () => {
    const secret = secretFor();

    expect(
      verifyStripeSignature({ secret, header: `t=${String(NOW_S)},v1=zz,v1=abc`, body: BODY, now }),
    ).toEqual({ ok: false, reason: 'no-signatures' });
  });

  it('refuses a missing header', () => {
    expect(
      verifyStripeSignature({ secret: secretFor(), header: undefined, body: BODY, now }),
    ).toEqual({
      ok: false,
      reason: 'missing-headers',
    });
  });

  it.each([
    ['no timestamp', (s: string) => `v1=${v1(s, NOW_S, BODY)}`],
    ['an empty one', (s: string) => `t=,v1=${v1(s, NOW_S, BODY)}`],
    ['one that is not a number', (s: string) => `t=soon,v1=${v1(s, NOW_S, BODY)}`],
    ['a fractional one', (s: string) => `t=${String(NOW_S)}.5,v1=${v1(s, NOW_S, BODY)}`],
    ['nothing at all', () => ''],
    ['parts with no value', () => 't,v1'],
  ])('refuses a header with %s', (_what, build) => {
    const secret = secretFor();

    expect(verifyStripeSignature({ secret, header: build(secret), body: BODY, now })).toEqual({
      ok: false,
      reason: 'malformed-timestamp',
    });
  });

  it('accepts a timestamp at the edge of the tolerance, either side', () => {
    const secret = secretFor();

    for (const t of [NOW_S - TIMESTAMP_TOLERANCE_SEC, NOW_S + TIMESTAMP_TOLERANCE_SEC]) {
      expect(verifyStripeSignature({ secret, header: header(secret, t), body: BODY, now })).toEqual(
        {
          ok: true,
        },
      );
    }
  });

  it.each([
    ['too old: a captured event replayed', -(TIMESTAMP_TOLERANCE_SEC + 1)],
    ['too far in the future: a signature good until then', TIMESTAMP_TOLERANCE_SEC + 1],
  ])('refuses a timestamp %s', (_what, offset) => {
    const secret = secretFor();

    expect(
      verifyStripeSignature({ secret, header: header(secret, NOW_S + offset), body: BODY, now }),
    ).toEqual({ ok: false, reason: 'timestamp-outside-tolerance' });
  });

  it('checks the time before the signature, so a stale forgery costs no HMAC', () => {
    /* A stale header with a garbage signature reports the timestamp, not the match. */
    expect(
      verifyStripeSignature({
        secret: secretFor(),
        header: `t=${String(NOW_S - 10_000)},v1=00`,
        body: BODY,
        now,
      }),
    ).toEqual({ ok: false, reason: 'timestamp-outside-tolerance' });
  });

  it('reads the clock it is given, and the real one by default', () => {
    const secret = secretFor();
    const real = Math.floor(Date.now() / 1000);

    expect(verifyStripeSignature({ secret, header: header(secret, real), body: BODY })).toEqual({
      ok: true,
    });
  });
});
