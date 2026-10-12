import { describe, expect, it } from 'vitest';

import { downgradeBlockers, downgradeRefusal, isDowngrade } from '../../src/billing/downgrade.js';

/**
 * Whether a winery fits the plan it wants to move down to, and what it is told
 * when it does not (P5-10).
 */

describe('what stands in the way of a downgrade', () => {
  it('is nothing for a winery at the lower plan’s caps exactly', () => {
    expect(downgradeBlockers({ wines: 300, domains: 1 }, 'CANTINA')).toEqual([]);
  });

  it('is the catalogue, one wine over', () => {
    expect(downgradeBlockers({ wines: 301, domains: 1 }, 'CANTINA')).toEqual([
      { what: 'wines', have: 301, allowed: 300 },
    ]);
  });

  it('is the domains, one over', () => {
    expect(downgradeBlockers({ wines: 0, domains: 2 }, 'CANTINA')).toEqual([
      { what: 'domains', have: 2, allowed: 1 },
    ]);
  });

  it('is both, catalogue first', () => {
    expect(downgradeBlockers({ wines: 412, domains: 3 }, 'CANTINA')).toEqual([
      { what: 'wines', have: 412, allowed: 300 },
      { what: 'domains', have: 3, allowed: 1 },
    ]);
  });

  it('reads the caps of the plan asked for', () => {
    expect(downgradeBlockers({ wines: 2_500, domains: 2 }, 'ECOMMERCE')).toEqual([]);
    expect(downgradeBlockers({ wines: 2_501, domains: 2 }, 'ECOMMERCE')).toEqual([
      { what: 'wines', have: 2_501, allowed: 2_500 },
    ]);
  });
});

describe('the refusal', () => {
  it('names each thing to reduce, by how much, against what the plan allows', () => {
    expect(
      downgradeRefusal('CANTINA', [
        { what: 'wines', have: 412, allowed: 300 },
        { what: 'domains', have: 2, allowed: 1 },
      ]),
    ).toBe(
      'Il piano Cantina comprende 300 vini e 1 dominio. Per passare a Cantina, prima archivia 112 vini (ne hai 412, il limite è 300) e rimuovi 1 dominio (ne hai 2, il limite è 1).',
    );
  });

  it('counts one wine, and several domains, as a person would', () => {
    expect(
      downgradeRefusal('CANTINA', [
        { what: 'wines', have: 301, allowed: 300 },
        { what: 'domains', have: 3, allowed: 1 },
      ]),
    ).toBe(
      'Il piano Cantina comprende 300 vini e 1 dominio. Per passare a Cantina, prima archivia 1 vino (ne hai 301, il limite è 300) e rimuovi 2 domini (ne hai 3, il limite è 1).',
    );
  });

  it('writes the plan’s caps in the plural when they are', () => {
    expect(downgradeRefusal('ECOMMERCE', [{ what: 'wines', have: 2_600, allowed: 2_500 }])).toMatch(
      /^Il piano E-commerce comprende 2500 vini e 2 domini\. /,
    );
  });

  it('is Italian unless the reader’s language is asked for (P6-12)', () => {
    /*
     * The dashboard prints the default as the API's refusal. The email about a
     * downgrade put off at period end is written in the winery's language, and
     * an English one must not be handed an Italian reason.
     */
    const blockers = [
      { what: 'wines', have: 412, allowed: 300 },
      { what: 'domains', have: 2, allowed: 1 },
    ] as const;

    expect(downgradeRefusal('CANTINA', blockers, 'it')).toBe(downgradeRefusal('CANTINA', blockers));
    expect(downgradeRefusal('CANTINA', blockers, 'en')).toBe(
      'Cantina allows 300 wines and 1 domain. To move to Cantina, archive 112 wines (412 of 300) and remove 1 domain (2 of 1) first.',
    );
    expect(
      downgradeRefusal(
        'ECOMMERCE',
        [
          { what: 'wines', have: 2_501, allowed: 2_500 },
          { what: 'domains', have: 4, allowed: 2 },
        ],
        'en',
      ),
    ).toBe(
      'E-commerce allows 2500 wines and 2 domains. To move to E-commerce, archive 1 wine (2501 of 2500) and remove 2 domains (4 of 2) first.',
    );
  });
});

describe('a downgrade', () => {
  it('is a move down the ladder, and only that', () => {
    expect(isDowngrade('ECOMMERCE', 'CANTINA')).toBe(true);
    expect(isDowngrade('CANTINA', 'ECOMMERCE')).toBe(false);
    expect(isDowngrade('CANTINA', 'CANTINA')).toBe(false);
  });
});
