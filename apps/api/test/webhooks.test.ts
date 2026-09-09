import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { WEBHOOK_PREFIX } from '../src/routes.js';
import type { DeliveryEvent, WebhooksPort } from '../src/webhooks.js';
import { fakeAuth } from './support/auth.js';

/**
 * The webhook surface — `POST /v1/webhooks/resend` (P0-64b).
 *
 * What is asserted here is the *surface*: what gets in, what is refused, and in
 * which order the handler does things. The behaviour underneath — that a claim
 * and a suppression commit together, and that a redelivery changes nothing —
 * belongs to real Postgres and is asserted in
 * `packages/db/test/webhooks.integration.test.ts`.
 *
 * The secret is generated per test and never written down. A `whsec_…` literal
 * in a fixture is a key-shaped literal in the repository, which the P0-08
 * history scan finds and which cannot be edited out once pushed (P0-56).
 */

const SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const PATH = `${WEBHOOK_PREFIX}/resend`;

const bouncePayload = {
  type: 'email.bounced',
  data: {
    to: ['dead@example.invalid'],
    bounce: { type: 'Permanent', subType: 'General', message: 'no such mailbox' },
  },
};

/**
 * Signs the way Svix does, not the way the verifier does.
 *
 * A fixture built out of the verifier's own helpers would agree with it about a
 * shared mistake — which is exactly how A1's timestamp bug survived a green
 * suite.
 */
const signed = (body: string, secret = SECRET, id = 'msg_2abcDEF') => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');

  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  };
};

const recorded: DeliveryEvent[] = [];

const port = (overrides: Partial<WebhooksPort> = {}): WebhooksPort => ({
  record: (event) => {
    recorded.push(event);
    return Promise.resolve({ type: 'email.bounced', suppressions: [], duplicate: false });
  },
  ...overrides,
});

const app = (options: { secret?: string | undefined; webhooks?: WebhooksPort } = {}) =>
  createApp({
    auth: fakeAuth(),
    readMemberships: () => Promise.resolve([]),
    resendWebhookSecret: 'secret' in options ? options.secret : SECRET,
    webhooks: options.webhooks ?? port(),
  });

const post = (built: ReturnType<typeof createApp>, body: string, headers: Record<string, string>) =>
  built.request(PATH, { method: 'POST', headers, body });

describe('a signed delivery', () => {
  it('is accepted and recorded under the signed message id', async () => {
    recorded.length = 0;
    const body = JSON.stringify(bouncePayload);

    const response = await post(app(), body, signed(body));

    expect(response.status).toBe(200);
    /*
     * The id comes from the header, which is inside the signed content — not
     * from the payload, which is merely *covered* by the signature. The
     * distinction matters the day a provider payload carries an id an attacker
     * could have influenced.
     */
    expect(recorded).toEqual([{ eventId: 'msg_2abcDEF', payload: bouncePayload }]);
  });

  it('reports the type and a count, never the addresses', async () => {
    const body = JSON.stringify(bouncePayload);

    const response = await post(
      app({
        webhooks: port({
          record: () =>
            Promise.resolve({
              type: 'email.bounced',
              suppressions: [{ address: 'dead@example.invalid', reason: 'hard_bounce' }],
              duplicate: false,
            }),
        }),
      }),
      body,
      signed(body),
    );

    const json = (await response.json()) as Record<string, unknown>;

    expect(json).toEqual({
      received: true,
      type: 'email.bounced',
      suppressed: 1,
      duplicate: false,
    });
    /*
     * Asserted against the serialised body rather than by reading the handler,
     * because what matters is what leaves the process: this response is written
     * into the provider's logs as well as ours.
     */
    expect(JSON.stringify(json)).not.toContain('dead@example.invalid');
  });

  it('reports a redelivery as a duplicate rather than as an error', async () => {
    const body = JSON.stringify(bouncePayload);

    const response = await post(
      app({
        webhooks: port({
          record: () =>
            Promise.resolve({ type: 'email.bounced', suppressions: [], duplicate: true }),
        }),
      }),
      body,
      signed(body),
    );

    /*
     * 200, deliberately. Any 4xx or 5xx here makes the provider retry, so
     * answering "I have already done this" with an error is how a redelivery
     * becomes a retry loop.
     */
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ duplicate: true });
  });
});

describe('an unsigned or mis-signed delivery', () => {
  const rejected = async (
    headers: Record<string, string>,
    body = JSON.stringify(bouncePayload),
  ) => {
    recorded.length = 0;
    const response = await post(app(), body, headers);

    // Nothing is written. The point of the check is that it happens *first*.
    expect(recorded).toEqual([]);
    return response;
  };

  it('is refused with no signature headers at all', async () => {
    const response = await rejected({ 'content-type': 'application/json' });

    expect(response.status).toBe(401);
  });

  it('is refused when the body was altered after signing', async () => {
    const original = JSON.stringify(bouncePayload);
    const headers = signed(original);

    const tampered = JSON.stringify({
      type: 'email.bounced',
      data: { to: ['ceo@cantina.example'], bounce: { type: 'Permanent' } },
    });

    /*
     * The attack this closes: a valid delivery captured and re-sent with a
     * different recipient would suppress an address of the attacker's choosing
     * — locking a real customer out of password reset, using our own bounce
     * machinery to do it.
     */
    expect((await rejected(headers, tampered)).status).toBe(401);
  });

  it('is refused when signed with a different secret', async () => {
    const body = JSON.stringify(bouncePayload);
    const headers = signed(body, `whsec_${randomBytes(24).toString('base64')}`);

    expect((await rejected(headers, body)).status).toBe(401);
  });

  it('says nothing about which part failed', async () => {
    const response = await rejected({ 'content-type': 'application/json' });
    const text = await response.text();

    /*
     * A `DomainError`'s message reaches the caller verbatim (P0-55). Telling an
     * unauthenticated caller which part of their forgery failed is a tutorial,
     * and it helps the one legitimate caller not at all — Resend's dashboard
     * shows them the status code, and we configure both ends.
     */
    for (const leak of ['timestamp', 'header', 'secret', 'svix', 'hmac']) {
      expect(text.toLowerCase()).not.toContain(leak);
    }
  });
});

describe('the endpoint with no secret configured', () => {
  it('answers 404 and records nothing', async () => {
    recorded.length = 0;
    const body = JSON.stringify(bouncePayload);

    const response = await post(app({ secret: undefined }), body, signed(body));

    /*
     * 404 rather than 500: with no secret this endpoint genuinely does not
     * exist yet, and that is both true and the least useful thing to tell
     * somebody probing for it. The operator sees failed deliveries in Resend's
     * dashboard, which is where they are looking that day.
     */
    expect(response.status).toBe(404);
    expect(recorded).toEqual([]);
  });

  it('refuses rather than accepting unverifiable deliveries', async () => {
    /*
     * The direction that matters. An endpoint that fell back to "no secret, so
     * no check" would accept anything anyone posted at it — and the thing it
     * accepts writes rows that stop mail being sent.
     */
    const response = await post(app({ secret: undefined }), '{}', {
      'content-type': 'application/json',
    });

    expect(response.status).toBe(404);
  });
});

describe('a body that is not a delivery event', () => {
  it('is acknowledged rather than refused when it is not JSON', async () => {
    recorded.length = 0;
    const body = 'not json at all';

    const response = await post(app(), body, signed(body));

    /*
     * **200, which is not the obvious answer.** The instinct is 400, on the
     * reasoning that a 4xx is final and a 5xx is retried — and that is not how
     * Svix works: every non-2xx is retried for hours, and an endpoint that
     * keeps failing is eventually disabled. A 400 would buy nothing, cost eight
     * redeliveries of a body that will never become readable, and push the
     * endpoint toward being switched off, which is E7 again from the other
     * direction.
     *
     * The status is chosen by whether a retry can help. It cannot here.
     */
    expect(response.status).toBe(200);
    expect(recorded).toEqual([]);
  });

  it('is acknowledged when the payload carries no readable type', async () => {
    const body = JSON.stringify({ data: { to: ['someone@example.com'] } });

    const response = await post(
      app({
        webhooks: port({
          record: () => {
            /*
             * The real error, thrown from a *structurally* identical class
             * rather than the imported one — which is the case
             * `isUnreadableWebhookPayload` exists for. Two copies of a module
             * in one bundle make `instanceof` false for an object that is this
             * error in every way that matters, and the consequence would be a
             * 500 the provider then retries for hours.
             */
            throw new (class extends Error {
              override name = 'UnreadableWebhookPayloadError';
            })('unreadable');
          },
        }),
      }),
      body,
      signed(body),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      type: 'unreadable',
      suppressed: 0,
    });
  });

  it('stays a 500 when the failure is ours, so the provider retries', async () => {
    const body = JSON.stringify(bouncePayload);

    const response = await post(
      app({ webhooks: port({ record: () => Promise.reject(new Error('database is down')) }) }),
      body,
      signed(body),
    );

    /*
     * The other half of the decision above, and the case where a retry really
     * does repair something. The ledger is what makes it safe: the claim and
     * the suppression share a transaction, so a failed attempt leaves nothing
     * claimed and the redelivery applies cleanly.
     */
    expect(response.status).toBe(500);
  });
});

describe('the surface itself', () => {
  it('needs no session, which is the only way a provider could ever call it', async () => {
    /*
     * `fakeAuth()` is signed out. If `requireUser` ever reached this surface —
     * by somebody mounting it under the dashboard, or moving the guard onto the
     * parent app — every delivery would 401 and the suppression list would
     * silently stop filling.
     */
    const body = JSON.stringify(bouncePayload);

    expect((await post(app(), body, signed(body))).status).toBe(200);
  });

  it('is declared, so the P0-49 boot check has something to find', () => {
    /*
     * `createApp` runs `assertEveryRouteDeclared` against the webhook prefix,
     * so an undeclared route here throws at construction. Building the app at
     * all is the assertion — and this is the surface where an undeclared route
     * would be reachable by the whole internet with no session in the way.
     */
    expect(() => app()).not.toThrow();
  });
});
