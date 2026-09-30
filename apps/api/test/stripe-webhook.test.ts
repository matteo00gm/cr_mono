import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { logger } from '../src/middleware/logger.js';
import { WEBHOOK_PREFIX } from '../src/routes.js';
import type { StripeDelivery, StripeEventsPort } from '../src/stripe-events.js';
import type { SignatureRejection } from '../src/surfaces/webhooks.js';
import { fakeAuth } from './support/auth.js';

/**
 * The Stripe webhook endpoint — `POST /v1/webhooks/stripe` (P5-03).
 *
 * The surface: what gets in, what is refused and recorded, and that the bytes
 * verified are the bytes Stripe sent. What an event *does* is P5-04's and
 * P5-05's, behind the port.
 *
 * The secret is built at runtime (P0-56).
 */

const SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const PATH = `${WEBHOOK_PREFIX}/stripe`;

const event = { id: 'evt_1Nq', type: 'invoice.payment_failed', data: { object: { id: 'in_1' } } };

/** Signs the way Stripe documents it: the whole secret, over `t.body`, hex. */
const signed = (body: string, { secret = SECRET, at = Date.now() } = {}) => {
  const t = String(Math.floor(at / 1000));
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` };
};

const delivered: StripeDelivery[] = [];
const refused: SignatureRejection[] = [];

const port = (overrides: Partial<StripeEventsPort> = {}): StripeEventsPort => ({
  record: (delivery) => {
    delivered.push(delivery);

    return Promise.resolve({ duplicate: false, applied: true });
  },
  ...overrides,
});

const app = (
  options: {
    secret?: string | undefined;
    stripeEvents?: StripeEventsPort;
    onSignatureRejected?: (rejection: SignatureRejection) => Promise<void>;
  } = {},
) =>
  createApp({
    auth: fakeAuth(),
    readMemberships: () => Promise.resolve([]),
    stripeWebhookSecret: 'secret' in options ? options.secret : SECRET,
    stripeEvents: options.stripeEvents ?? port(),
    onSignatureRejected:
      options.onSignatureRejected ??
      ((rejection) => {
        refused.push(rejection);

        return Promise.resolve();
      }),
  });

const post = (built: ReturnType<typeof createApp>, body: string, headers: Record<string, string>) =>
  built.request(PATH, { method: 'POST', headers, body });

afterEach(() => {
  vi.restoreAllMocks();
  delivered.length = 0;
  refused.length = 0;
});

describe('a signed event', () => {
  it('reaches the port with its id, its type and the payload, and is acknowledged', async () => {
    const body = JSON.stringify(event);
    const response = await post(app(), body, signed(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      type: 'invoice.payment_failed',
      duplicate: false,
      applied: true,
    });
    expect(delivered).toEqual([
      { eventId: 'evt_1Nq', type: 'invoice.payment_failed', payload: event },
    ]);
  });

  it('is verified over the bytes Stripe sent, not a re-serialisation of them', async () => {
    /*
     * The ordering test the row asks for. This body is valid JSON that no
     * `JSON.stringify` would produce — indentation, an escaped character, a
     * trailing space — so it verifies only if the handler checks the raw bytes.
     * Anything that parsed the body first and handed on a re-encoding would
     * fail every real delivery, and the natural "fix" would be loosening the
     * check until it proved nothing.
     */
    const body = '{\n  "id": "evt_1Nq",\n  "type": "invoice.paid",\n  "note": "caf\\u00e9"\n} ';
    const response = await post(app(), body, signed(body));

    expect(response.status).toBe(200);
    expect(delivered[0]?.payload).toEqual({ id: 'evt_1Nq', type: 'invoice.paid', note: 'café' });
  });

  it('is told apart from a duplicate by what the port says', async () => {
    const body = JSON.stringify(event);
    const response = await post(
      app({
        stripeEvents: port({ record: () => Promise.resolve({ duplicate: true, applied: false }) }),
      }),
      body,
      signed(body),
    );

    expect(await response.json()).toMatchObject({ duplicate: true, applied: false });
  });

  it('needs no session, which is the only way Stripe could ever call it', async () => {
    const body = JSON.stringify(event);

    expect((await post(app(), body, signed(body))).status).toBe(200);
  });
});

describe('an unsigned or mis-signed event', () => {
  const cases: [string, (body: string) => Record<string, string>][] = [
    ['no signature', () => ({ 'content-type': 'application/json' })],
    [
      'another secret’s signature',
      (body) => signed(body, { secret: `whsec_${randomBytes(24).toString('base64')}` }),
    ],
    ['a stale timestamp', (body) => signed(body, { at: Date.now() - 10 * 60_000 })],
    ['a malformed header', () => ({ 'stripe-signature': 'nonsense' })],
  ];

  it.each(cases)('is refused with %s, before the port hears of it', async (_what, headers) => {
    const body = JSON.stringify(event);
    const response = await post(app(), body, headers(body));

    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).toContain('Signature verification failed.');
    expect(delivered).toEqual([]);
  });

  it('is refused when the body was changed after signing', async () => {
    const body = JSON.stringify(event);
    const tampered = body.replace('payment_failed', 'payment_succeeded');

    expect((await post(app(), tampered, signed(body))).status).toBe(401);
    expect(delivered).toEqual([]);
  });

  it('is recorded as a security event, with the provider and the reason', async () => {
    const body = JSON.stringify(event);

    await post(
      app(),
      body,
      signed(body, { secret: `whsec_${randomBytes(24).toString('base64')}` }),
    );

    expect(refused).toEqual([{ provider: 'stripe', reason: 'no-match' }]);
  });

  it('says nothing about which part failed', async () => {
    const body = JSON.stringify(event);
    const stale = await post(app(), body, signed(body, { at: Date.now() - 10 * 60_000 }));
    const wrong = await post(
      app(),
      body,
      signed(body, { secret: `whsec_${randomBytes(24).toString('base64')}` }),
    );

    /* Everything but the per-request id: the code and the words are identical. */
    const readable = async (response: Response) => {
      const { error } = (await response.json()) as { error: { code: string; message: string } };

      return { code: error.code, message: error.message };
    };

    expect(await readable(stale)).toEqual(await readable(wrong));
  });

  it('is refused the same way when the recorder rejects', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const body = JSON.stringify(event);
    const response = await post(
      app({ onSignatureRejected: () => Promise.reject(new Error('database down')) }),
      body,
      { 'content-type': 'application/json' },
    );

    expect(response.status).toBe(401);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        { kind: 'webhook_rejection_unrecorded', type: 'missing-headers' },
        expect.any(String),
      );
    });
  });

  it('is refused the same way when the recorder throws before it can reject', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const body = JSON.stringify(event);
    const response = await post(
      app({
        onSignatureRejected: () => {
          throw new Error('not even a promise');
        },
      }),
      body,
      { 'content-type': 'application/json' },
    );

    expect(response.status).toBe(401);
    expect(warn).toHaveBeenCalledWith(
      { kind: 'webhook_rejection_unrecorded', type: 'missing-headers' },
      expect.any(String),
    );
  });
});

describe('the endpoint with no secret configured', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('does not exist when the secret is %s', async (_what, secret) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const body = JSON.stringify(event);
    const response = await post(app({ secret }), body, signed(body));

    expect(response.status).toBe(404);
    expect(delivered).toEqual([]);
    expect(warn).toHaveBeenCalledWith({ kind: 'webhook_unconfigured' }, expect.any(String));
  });
});

describe('a signed body that is not an event', () => {
  it.each([
    ['not JSON', 'this is not json', 'webhook_body_not_json'],
    ['JSON with no id', JSON.stringify({ type: 'invoice.paid' }), 'webhook_payload_unreadable'],
    ['JSON with no type', JSON.stringify({ id: 'evt_1' }), 'webhook_payload_unreadable'],
    ['an empty id', JSON.stringify({ id: '', type: 'invoice.paid' }), 'webhook_payload_unreadable'],
  ])(
    'is acknowledged when it is %s, so Stripe stops resending it, and logged',
    async (_what, body, kind) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const response = await post(app(), body, signed(body));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true, type: 'unreadable' });
      expect(delivered).toEqual([]);
      expect(warn).toHaveBeenCalledWith({ kind }, expect.any(String));
    },
  );
});

describe('when applying fails', () => {
  it('answers 500, which Stripe retries, rather than a 200 that drops the event', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const body = JSON.stringify(event);
    const response = await post(
      app({ stripeEvents: port({ record: () => Promise.reject(new Error('database down')) }) }),
      body,
      signed(body),
    );

    expect(response.status).toBe(500);
  });

  it('answers 500 while no port is wired, for the same reason', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const body = JSON.stringify(event);
    const response = await post(
      createApp({
        auth: fakeAuth(),
        readMemberships: () => Promise.resolve([]),
        stripeWebhookSecret: SECRET,
      }),
      body,
      signed(body),
    );

    expect(response.status).toBe(500);
  });
});
