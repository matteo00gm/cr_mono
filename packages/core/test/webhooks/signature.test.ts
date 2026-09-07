import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  TIMESTAMP_TOLERANCE_SEC,
  verifySvixSignature,
  type SvixHeaders,
} from '../../src/webhooks/signature.js';

/**
 * Svix signature verification (P0-64b).
 *
 * **The signing helper below is the reason these tests are worth anything.** It
 * builds a signature the way Svix does rather than the way the verifier does —
 * a fixture that called the verifier's own internals would agree with it about
 * a shared mistake, which is precisely how A1's timestamp bug survived a green
 * suite: the fake and the code were written from one assumption and neither
 * ever met Postgres.
 *
 * The secret is built at runtime and never written down. A `whsec_…` literal in
 * a fixture is a key-shaped literal in the repository, which the P0-08 history
 * scan finds and which cannot be edited out once pushed (P0-56).
 */

const secretFor = () => `whsec_${randomBytes(24).toString('base64')}`;

const sign = (secret: string, id: string, timestamp: string, body: string): string => {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
};

const BODY = JSON.stringify({ type: 'email.bounced', data: { to: ['dead@example.invalid'] } });

/** Fixed so the tolerance can be reasoned about rather than raced against. */
const NOW_MS = 1_760_000_000_000;
const nowSeconds = () => Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;

const delivery = (
  secret: string,
  overrides: Partial<SvixHeaders> = {},
  body = BODY,
): { headers: SvixHeaders; body: string } => {
  const id = 'msg_2abcDEF';
  const timestamp = String(nowSeconds());

  return {
    body,
    headers: {
      id,
      timestamp,
      signature: sign(secret, id, timestamp, body),
      ...overrides,
    },
  };
};

describe('verifySvixSignature', () => {
  it('accepts a delivery signed with the endpoint secret', () => {
    const secret = secretFor();
    const { headers, body } = delivery(secret);

    expect(verifySvixSignature({ secret, headers, body, now })).toEqual({ ok: true });
  });

  it('accepts a secret written without the whsec_ prefix', () => {
    /*
     * The prefix is a display convention, not part of the key. Some dashboards
     * copy the bare base64, and a verifier that only handled one form would
     * reject every delivery — a failure whose natural fix is somebody turning
     * verification off to get the integration working.
     */
    const secret = secretFor();
    const { headers, body } = delivery(secret);

    const bare = secret.slice('whsec_'.length);
    expect(verifySvixSignature({ secret: bare, headers, body, now })).toEqual({ ok: true });
  });

  it('rejects a body altered after signing', () => {
    const secret = secretFor();
    const { headers } = delivery(secret);

    const tampered = JSON.stringify({ type: 'email.bounced', data: { to: ['ceo@example.com'] } });

    expect(verifySvixSignature({ secret, headers, body: tampered, now })).toEqual({
      ok: false,
      reason: 'no-match',
    });
  });

  it('rejects a signature made with a different secret', () => {
    const { headers, body } = delivery(secretFor());

    expect(verifySvixSignature({ secret: secretFor(), headers, body, now })).toEqual({
      ok: false,
      reason: 'no-match',
    });
  });

  it('rejects a delivery whose id was swapped after signing', () => {
    /*
     * The id is inside the signed content, and this is what proves it. Without
     * that binding an attacker could replay a legitimate delivery under a fresh
     * id and defeat the idempotency claim, applying the same bounce twice.
     */
    const secret = secretFor();
    const { headers, body } = delivery(secret, { id: 'msg_somethingElse' });

    expect(verifySvixSignature({ secret, headers, body, now })).toEqual({
      ok: false,
      reason: 'no-match',
    });
  });

  describe('the timestamp', () => {
    it('rejects a delivery older than the tolerance', () => {
      const secret = secretFor();
      const stale = String(nowSeconds() - TIMESTAMP_TOLERANCE_SEC - 1);
      const headers = {
        id: 'msg_old',
        timestamp: stale,
        signature: sign(secret, 'msg_old', stale, BODY),
      };

      /*
       * Correctly signed, and refused anyway. This is the only thing standing
       * between us and an indefinite replay of a captured request: the
       * `processed_webhooks` claim stops a *repeat* of an id we have seen, and
       * a delivery captured before it ever reached us replays perfectly against
       * an empty ledger.
       */
      expect(verifySvixSignature({ secret, headers, body: BODY, now })).toEqual({
        ok: false,
        reason: 'timestamp-outside-tolerance',
      });
    });

    it('rejects a delivery from the future by the same margin', () => {
      const secret = secretFor();
      const ahead = String(nowSeconds() + TIMESTAMP_TOLERANCE_SEC + 1);
      const headers = {
        id: 'msg_ahead',
        timestamp: ahead,
        signature: sign(secret, 'msg_ahead', ahead, BODY),
      };

      expect(verifySvixSignature({ secret, headers, body: BODY, now })).toEqual({
        ok: false,
        reason: 'timestamp-outside-tolerance',
      });
    });

    it('accepts one at the edge of the tolerance, so clock skew is survivable', () => {
      const secret = secretFor();
      const edge = String(nowSeconds() - TIMESTAMP_TOLERANCE_SEC);
      const headers = {
        id: 'msg_edge',
        timestamp: edge,
        signature: sign(secret, 'msg_edge', edge, BODY),
      };

      expect(verifySvixSignature({ secret, headers, body: BODY, now })).toEqual({ ok: true });
    });

    it('rejects a timestamp that is not a number', () => {
      const secret = secretFor();
      const { headers, body } = delivery(secret, { timestamp: 'yesterday' });

      expect(verifySvixSignature({ secret, headers, body, now })).toEqual({
        ok: false,
        reason: 'malformed-timestamp',
      });
    });
  });

  describe('the signature header', () => {
    it('accepts when any one of several signatures matches', () => {
      /*
       * Secret rotation is the only reason this case exists, and it is the one
       * that breaks in production rather than in a test: Svix sends one entry
       * per active endpoint secret, so a verifier reading only the first works
       * perfectly until the day somebody rotates, and then the endpoint is down
       * with no visible cause.
       */
      const secret = secretFor();
      const { headers, body } = delivery(secret);
      const stale = sign(secretFor(), headers.id ?? '', headers.timestamp ?? '', body);

      expect(
        verifySvixSignature({
          secret,
          headers: { ...headers, signature: `${stale} ${headers.signature ?? ''}` },
          body,
          now,
        }),
      ).toEqual({ ok: true });
    });

    it('ignores entries from schemes it does not know', () => {
      const secret = secretFor();
      const { headers, body } = delivery(secret);

      expect(
        verifySvixSignature({
          secret,
          headers: { ...headers, signature: `v2,ZmFrZQ== ${headers.signature ?? ''}` },
          body,
          now,
        }),
      ).toEqual({ ok: true });
    });

    it('rejects a header carrying no v1 entry at all', () => {
      const secret = secretFor();
      const { headers, body } = delivery(secret, { signature: 'v2,ZmFrZQ==' });

      expect(verifySvixSignature({ secret, headers, body, now })).toEqual({
        ok: false,
        reason: 'no-signatures',
      });
    });

    it('rejects a signature of the wrong length without throwing', () => {
      /*
       * `timingSafeEqual` throws on a length mismatch, so a verifier that
       * handed it both buffers directly would turn a truncated signature into a
       * 500 — an unauthenticated caller crashing the handler, and a 5xx the
       * provider then retries.
       */
      const secret = secretFor();
      const { headers, body } = delivery(secret, { signature: 'v1,c2hvcnQ=' });

      expect(verifySvixSignature({ secret, headers, body, now })).toEqual({
        ok: false,
        reason: 'no-match',
      });
    });
  });

  it.each([
    ['id', { id: undefined }],
    ['timestamp', { timestamp: undefined }],
    ['signature', { signature: undefined }],
  ])('rejects a delivery with no %s header', (_name, missing) => {
    const secret = secretFor();
    const { headers, body } = delivery(secret, missing);

    expect(verifySvixSignature({ secret, headers, body, now })).toEqual({
      ok: false,
      reason: 'missing-headers',
    });
  });
});
