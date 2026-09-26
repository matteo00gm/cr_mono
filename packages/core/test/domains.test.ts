import type { NormalizeFailure } from '@catalogorosso/security';
import type { WellKnownFailure } from '@catalogorosso/security/net';
import { describe, expect, it } from 'vitest';

import {
  capFor,
  capMessage,
  DOMAIN_CAPS,
  LAST_DOMAIN_WARNING,
  METHOD_COLUMN,
  ORIGIN_UNAVAILABLE,
  refusalMessage,
  siblingOrigin,
  verificationToken,
  VERIFY_METHODS,
  wellKnownRefusalMessage,
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

describe('what a seller is told when the file check fails (P4-03)', () => {
  const EVERY: readonly WellKnownFailure[] = ['not_found', 'mismatch', 'unreachable'];

  it.each(EVERY)('has its own message for %s', (reason) => {
    /* Three different places to look: upload it, check what is in it, and
     * nothing you can fix. One shared string would send every seller to the
     * wrong one. */
    expect(wellKnownRefusalMessage(reason).length).toBeGreaterThan(20);
  });

  it('is different for every reason', () => {
    const messages = EVERY.map((reason) => wellKnownRefusalMessage(reason));

    expect(new Set(messages).size).toBe(EVERY.length);
  });

  it('says what to do about a missing file', () => {
    expect(wellKnownRefusalMessage('not_found')).toMatch(/upload/iu);
  });

  it('warns that a themed page looks like this, because most hosts serve one', () => {
    expect(wellKnownRefusalMessage('mismatch')).toMatch(/themed|404/iu);
  });

  it('never names what our own network refused', () => {
    /*
     * **The flattening is the security property.** `guardedFetch`'s reasons say
     * which addresses we would not connect to and which redirects we would not
     * follow; a caller who could read them could map our defences one domain at
     * a time. "We could not reach your site" is true and gives them nothing.
     */
    const message = wellKnownRefusalMessage('unreachable');

    expect(message).not.toMatch(/private|internal|blocked|metadata|redirect|10\.|169\.254/iu);
    expect(message).toMatch(/could not reach/iu);
  });
});

describe('the proofs on offer', () => {
  it('are the two a seller can actually produce', () => {
    /*
     * DNS is not always theirs to change — plenty would have to ask whoever
     * built the site — and a file on the storefront is. Offering one and not
     * the other strands exactly those sellers.
     */
    expect(VERIFY_METHODS).toEqual(['dns', 'wellknown']);
  });

  it('each map to their own column value', () => {
    expect(METHOD_COLUMN.dns).toBe('DNS_TXT');
    expect(METHOD_COLUMN.wellknown).toBe('WELL_KNOWN');
  });
});

describe('the other spelling of an origin (P4-05)', () => {
  it('gives an apex its www', () => {
    expect(siblingOrigin('https://winery.com', 'winery.com')).toBe('https://www.winery.com');
  });

  it('gives a www its apex', () => {
    expect(siblingOrigin('https://www.winery.com', 'winery.com')).toBe('https://winery.com');
  });

  it('carries the scheme and the port across', () => {
    /* A sibling on a different port is a different origin, and a development
     * run on `http://localhost:3000` has to pair with itself, not with 443. */
    expect(siblingOrigin('http://winery.com:3000', 'winery.com')).toBe(
      'http://www.winery.com:3000',
    );
  });

  it('has nothing to give an ordinary subdomain', () => {
    /*
     * **`shop.winery.com` is not an apex and `www.shop.winery.com` is not a
     * spelling of it.** Both are subdomains a seller adds deliberately, and
     * inventing a `www` for each one would widen an allowlist nobody asked to
     * widen — which §3.3 forbids more than it forbids the inconvenience.
     */
    expect(siblingOrigin('https://shop.winery.com', 'winery.com')).toBeUndefined();
    expect(siblingOrigin('https://www.shop.winery.com', 'winery.com')).toBeUndefined();
  });

  it('has nothing to give a host that is not under the domain at all', () => {
    /* The registrable domain is what was proved. A mismatch here would mean
     * pairing an origin with a host nobody proved anything about. */
    expect(siblingOrigin('https://evil.example', 'winery.com')).toBeUndefined();
    expect(siblingOrigin('https://winery.com.evil.example', 'winery.com')).toBeUndefined();
  });

  it('has nothing to give something that is not an origin', () => {
    expect(siblingOrigin('not a url', 'winery.com')).toBeUndefined();
  });

  it('is its own inverse', () => {
    /* Verifying either spelling has to produce the same pair, or which one the
     * seller happened to type would decide what their widget runs on. */
    const apex = 'https://winery.com';
    const www = siblingOrigin(apex, 'winery.com');

    expect(siblingOrigin(www ?? '', 'winery.com')).toBe(apex);
  });
});

describe('what a seller is told before removing their last domain (P4-06)', () => {
  it('says what removing it does, in consequences rather than in rules', () => {
    /*
     * **A confirmation, not a refusal.** It is their domain and their decision
     * — what they must not be able to do is make it by accident, and "cannot
     * remove that domain" tells them neither what would happen nor how to go
     * ahead.
     */
    expect(LAST_DOMAIN_WARNING).toMatch(/only verified domain/iu);
    expect(LAST_DOMAIN_WARNING).toMatch(/switches the widget off/iu);
  });

  it('says it happens immediately, because that is the part that surprises people', () => {
    expect(LAST_DOMAIN_WARNING).toMatch(/immediat/iu);
  });

  it('says how to go ahead', () => {
    /* A confirmation that does not say how to confirm is a refusal with extra
     * steps. */
    expect(LAST_DOMAIN_WARNING).toMatch(/confirm=true/u);
  });
});
