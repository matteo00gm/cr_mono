import type { NormalizeFailure } from '@catalogorosso/security';
import { describe, expect, it } from 'vitest';

import {
  capFor,
  capMessage,
  DOMAIN_CAPS,
  ORIGIN_UNAVAILABLE,
  refusalMessage,
  verificationToken,
} from '../src/domains.js';

/**
 * What a seller is told when a domain is refused (P4-01, §3.3).
 *
 * **This is the one screen every seller has to get through before the product
 * works at all**, so "invalid domain" on it is a support ticket by design. Each
 * reason gets a message that says what was wrong *and* what to do instead, and
 * the table below is what stops one being added without either.
 */

const EVERY_REASON: readonly NormalizeFailure[] = [
  'invalid_url',
  'not_https',
  'ip_literal',
  'public_suffix',
  'single_label',
  'has_path',
  'localhost',
];

describe('the message for a refused domain', () => {
  it.each(EVERY_REASON)('exists for %s, and tells the seller what to do', (reason) => {
    const message = refusalMessage(reason);

    expect(message.length).toBeGreaterThan(20);
    /* A sentence, not a code. `not_https` reaching a seller is the failure. */
    expect(message).not.toMatch(/_/u);
    expect(message).toMatch(/\.$/u);
  });

  it('is different for every reason', () => {
    /* One shared string would pass every assertion above and tell a seller
     * nothing — which is the "invalid domain" this table exists to replace. */
    const messages = EVERY_REASON.map((reason) => refusalMessage(reason));

    expect(new Set(messages).size).toBe(EVERY_REASON.length);
  });

  it('names the thing that was wrong', () => {
    expect(refusalMessage('not_https')).toMatch(/https/iu);
    expect(refusalMessage('ip_literal')).toMatch(/IP address/iu);
    expect(refusalMessage('has_path')).toMatch(/path/iu);
    expect(refusalMessage('localhost')).toMatch(/localhost/iu);
    expect(refusalMessage('single_label')).toMatch(/suffix/iu);
    expect(refusalMessage('public_suffix')).toMatch(/suffix/iu);
  });
});

describe('the message for an origin somebody else holds', () => {
  it('says nothing about who holds it', () => {
    /*
     * **The generality is the security property** (§3.2). "That belongs to
     * another winery" confirms a competitor is a customer, and run against a
     * list of domains it enumerates our customer base.
     */
    expect(ORIGIN_UNAVAILABLE).not.toMatch(/tenant|another|owner|belongs|customer|winery/iu);
  });

  it('still leaves the seller somewhere to go', () => {
    /* A refusal with no next step on the one screen that gates the product is
     * how a legitimate seller who mistyped gives up. */
    expect(ORIGIN_UNAVAILABLE).toMatch(/support/iu);
  });
});

describe('a verification nonce', () => {
  it('is 32 bytes of hex', () => {
    expect(verificationToken()).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is different every time', () => {
    /*
     * Its only job is to be unguessable: a seller who could predict the nonce
     * another seller will be issued could stage the proof before the claim.
     */
    const tokens = new Set(Array.from({ length: 50 }, () => verificationToken()));

    expect(tokens.size).toBe(50);
  });
});

describe('how many domains a plan includes', () => {
  it('is what the plans sell', () => {
    /* A published number. Changing one here is a pricing change, and it should
     * read as one in the diff rather than as a config tweak. */
    expect(DOMAIN_CAPS).toEqual({ CANTINA: 1, ECOMMERCE: 2, none: 1 });
  });

  it('rises with the plan', () => {
    expect(capFor('ECOMMERCE')).toBeGreaterThan(capFor('CANTINA'));
  });

  it('lets a winery with no plan yet add the one domain it came to add', () => {
    /*
     * Every winery is `none` between signup and checkout. Nought here would
     * mean a seller cannot try the product at all, on the screen that gates
     * everything else.
     */
    expect(capFor('none')).toBeGreaterThan(0);
  });

  it('never gives an unsubscribed winery more than a paying one', () => {
    expect(capFor('none')).toBeLessThanOrEqual(capFor('CANTINA'));
  });
});

describe('what a seller at their cap is told', () => {
  it('names the plan, the number, and where to change it', () => {
    /*
     * **A bare "limit reached" is a support ticket.** A seller who cannot tell
     * whether they are one domain short or simply on the wrong plan has no way
     * to act on the refusal.
     */
    const message = capMessage('CANTINA', 1);

    expect(message).toMatch(/Cantina/u);
    expect(message).toMatch(/\b1 domain\b/u);
    expect(message).toMatch(/Fatturazione/u);
  });

  it('counts in the plural when there is more than one', () => {
    expect(capMessage('ECOMMERCE', 2)).toMatch(/\b2 domains\b/u);
    expect(capMessage('ECOMMERCE', 2)).toMatch(/E-commerce/u);
  });

  it('calls an unsubscribed winery something a seller would recognise', () => {
    /* `none` is an enum value, not a word anybody has seen on an invoice. */
    const message = capMessage('none', 1);

    expect(message).not.toMatch(/none/u);
    expect(message).toMatch(/trial/iu);
  });

  it('says what to do, not only what went wrong', () => {
    expect(capMessage('CANTINA', 1)).toMatch(/remove/iu);
  });
});
