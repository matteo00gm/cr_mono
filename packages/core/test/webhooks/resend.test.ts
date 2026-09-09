import { describe, expect, it } from 'vitest';

import {
  isUnreadableWebhookPayload,
  suppressionsFor,
  UnreadableWebhookPayloadError,
} from '../../src/webhooks/resend.js';

/**
 * What a Resend event means for the suppression list (P0-64b).
 *
 * A table of payloads rather than a fake request, because the decision under
 * test is a domain rule with costs in both directions — a missed suppression
 * spends sending reputation, a wrong one locks a paying customer out of their
 * own account recovery — and neither cost is visible from an HTTP status.
 */

const bounce = (type: string | undefined, to: unknown = ['dead@example.invalid']) => ({
  type: 'email.bounced',
  data: {
    to,
    ...(type === undefined ? {} : { bounce: { type, subType: 'General', message: 'no mailbox' } }),
  },
});

describe('a bounce', () => {
  it('suppresses on a permanent bounce, with the provider wording kept', () => {
    const outcome = suppressionsFor(bounce('Permanent'));

    expect(outcome.suppressions).toEqual([
      { address: 'dead@example.invalid', reason: 'hard_bounce', detail: 'General: no mailbox' },
    ]);
  });

  it.each(['Transient', 'Undetermined'])('does not suppress on a %s bounce', (type) => {
    /*
     * **The decision most worth arguing with, asserted rather than commented.**
     * A transient bounce is a full mailbox or a greylisting, and the address
     * belongs to a real person who will read their mail next week. Suppressing
     * one produces exactly the failure P0-64 exists to prevent: a customer who
     * cannot reset their password, with no self-service way back, because a
     * mailbox was full on the day they were invited.
     */
    expect(suppressionsFor(bounce(type)).suppressions).toEqual([]);
  });

  it('does not suppress when the provider sent no bounce type at all', () => {
    /*
     * Deliberately not the fail-closed instinct, and the asymmetry decides it:
     * a missed suppression costs one more message to a dead address, which
     * bounces again and arrives here again; a wrong one costs a locked-out
     * customer and a table only an operator can edit.
     */
    expect(suppressionsFor(bounce(undefined)).suppressions).toEqual([]);
  });

  it('omits detail rather than writing an empty string when the provider sent none', () => {
    /*
     * `detail` is what an operator reads when asking why a customer cannot
     * receive mail. An empty string there looks like a wiped explanation; an
     * absent column reads as "the provider did not say", which is the truth.
     */
    const outcome = suppressionsFor({
      type: 'email.bounced',
      data: { to: ['bare@example.invalid'], bounce: { type: 'Permanent' } },
    });

    expect(outcome.suppressions).toEqual([
      { address: 'bare@example.invalid', reason: 'hard_bounce' },
    ]);
  });

  it('matches the type case-insensitively', () => {
    expect(suppressionsFor(bounce('permanent')).suppressions).toHaveLength(1);
  });

  it('normalises the address the way the send path looks it up', () => {
    /*
     * The table's primary key *is* the normalised address, and the send path
     * asks with `normaliseAddress`. A row written as `Dead@Example.invalid`
     * would sit in the table looking suppressed while every send sailed past
     * it.
     */
    expect(suppressionsFor(bounce('Permanent', ['  Dead@Example.INVALID '])).suppressions).toEqual([
      expect.objectContaining({ address: 'dead@example.invalid' }),
    ]);
  });

  it('handles a single recipient sent as a string', () => {
    expect(suppressionsFor(bounce('Permanent', 'dead@example.invalid')).suppressions).toHaveLength(
      1,
    );
  });

  it('suppresses every recipient of a multi-recipient event', () => {
    const outcome = suppressionsFor(
      bounce('Permanent', ['a@example.invalid', 'b@example.invalid']),
    );

    expect(outcome.suppressions.map((s) => s.address)).toEqual([
      'a@example.invalid',
      'b@example.invalid',
    ]);
  });

  it('suppresses nothing when there is no recipient to suppress', () => {
    expect(suppressionsFor(bounce('Permanent', [])).suppressions).toEqual([]);

    // Written out rather than via the helper, whose default `to` would fill in
    // a recipient and quietly test the opposite of what this says.
    expect(
      suppressionsFor({
        type: 'email.bounced',
        data: { bounce: { type: 'Permanent' } },
      }).suppressions,
    ).toEqual([]);
  });
});

describe('a complaint', () => {
  it('always suppresses, with no equivalent of the bounce-type check', () => {
    /*
     * Somebody pressed "this is spam". The address works perfectly, which is
     * why continuing to mail it is worse than mailing a dead one: a complaint
     * rate is the strongest negative signal a mailbox provider acts on, and the
     * sender has been told explicitly to stop.
     */
    const outcome = suppressionsFor({
      type: 'email.complained',
      data: { to: ['annoyed@example.com'] },
    });

    expect(outcome.suppressions).toEqual([
      {
        address: 'annoyed@example.com',
        reason: 'complaint',
        detail: 'reported as spam by the recipient',
      },
    ]);
  });
});

describe('anything else', () => {
  it.each(['email.sent', 'email.delivered', 'email.opened', 'contact.created'])(
    'acknowledges %s without suppressing',
    (type) => {
      const outcome = suppressionsFor({ type, data: { to: ['fine@example.com'] } });

      expect(outcome).toEqual({ type, suppressions: [] });
    },
  );

  it('accepts an unknown type it has never heard of', () => {
    /*
     * A provider that adds `email.delayed` next month must not turn this
     * endpoint into a wall of failures in their dashboard — and each of those
     * failures is a retry, so rejecting what we do not understand is how a
     * working integration becomes a loop.
     */
    expect(suppressionsFor({ type: 'email.something_new' }).suppressions).toEqual([]);
  });

  it('tolerates fields the provider added since this was written', () => {
    /*
     * Non-strict on purpose, which is the opposite of how request bodies are
     * validated here. The difference is who is sending: a request body comes
     * from a caller we may refuse, and a webhook payload comes from a provider
     * who will add fields without telling us. A strict schema turns their next
     * release into our silent outage.
     */
    const outcome = suppressionsFor({
      type: 'email.bounced',
      data: {
        to: ['dead@example.invalid'],
        bounce: { type: 'Permanent', subType: 'General', diagnosticCode: '550 5.1.1' },
        tags: [{ name: 'campaign', value: 'invite' }],
      },
      region: 'eu-west-1',
    });

    expect(outcome.suppressions).toHaveLength(1);
  });

  it.each([[null], [42], ['a string'], [{ data: {} }]])(
    'refuses a payload with no readable type: %s',
    (payload) => {
      expect(() => suppressionsFor(payload)).toThrow(UnreadableWebhookPayloadError);
    },
  );
});

describe('isUnreadableWebhookPayload', () => {
  it('recognises the error it was thrown', () => {
    expect(isUnreadableWebhookPayload(new UnreadableWebhookPayloadError())).toBe(true);
  });

  it('recognises a structurally identical error from another module copy', () => {
    /*
     * The case the structural check exists for, and it is not hypothetical: a
     * Lambda bundle can carry a workspace link beside a bundled copy of this
     * module, and then `instanceof` is false for an object that is this error
     * in every way that matters. The consequence is a 500 where a 200 belongs,
     * and a provider redelivering a payload that will never become readable.
     */
    const twin = new (class extends Error {
      override name = 'UnreadableWebhookPayloadError';
    })('from the other copy');

    expect(isUnreadableWebhookPayload(twin)).toBe(true);
  });

  it.each([[new Error('something else')], ['a string'], [null], [undefined]])(
    'does not claim %s',
    (value) => {
      expect(isUnreadableWebhookPayload(value)).toBe(false);
    },
  );
});
