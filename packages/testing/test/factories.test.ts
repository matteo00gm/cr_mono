import {
  membershipInsert,
  productInsert,
  tenantDomainInsert,
  tenantInsert,
} from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import {
  italianCsvFixture,
  makeMembership,
  makeProduct,
  makeTenant,
  makeTenantDomain,
  wineFixtures,
} from '../src/factories.js';

/**
 * Factories produce rows the contracts accept (P0-43).
 *
 * This is the assertion that keeps the fixtures honest as the schema moves. A
 * factory that drifts from its table produces suites that fail at insert with
 * a constraint error, several layers away from the fixture that caused it.
 */

describe('makeTenant', () => {
  it('produces a row the contract accepts', () => {
    const { id, ...insert } = makeTenant();

    expect(tenantInsert.safeParse(insert).success).toBe(true);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the id, because P0-37 needs it before the insert', () => {
    // `tenants` carries WITH CHECK (id = app.tenant_id), so the caller has to
    // know the id in order to set the context the insert is checked against.
    // A factory that let the database generate it would be unusable.
    expect(makeTenant().id).toBeTruthy();
  });

  it('gives every tenant a distinct slug', () => {
    // The citext unique index is global. A fixed slug means the second tenant
    // in any suite collides, and the failure reads as a schema bug.
    const slugs = new Set(Array.from({ length: 20 }, () => makeTenant().slug));

    expect(slugs.size).toBe(20);
  });

  it('takes overrides', () => {
    expect(makeTenant({ name: 'Altra Cantina' }).name).toBe('Altra Cantina');
  });
});

describe('makeProduct', () => {
  it('produces a row the contract accepts', () => {
    expect(productInsert.safeParse(makeProduct()).success).toBe(true);
  });

  it('produces accepted rows for every wine in the set', () => {
    // Each fixture differs in which optional fields it carries, so parsing one
    // proves little about the others.
    for (let index = 0; index < wineFixtures.length; index += 1) {
      expect(productInsert.safeParse(makeProduct(index)).success, String(index)).toBe(true);
    }
  });

  it('varies rather than repeating when asked for more than it has', () => {
    // Twenty identical rows make a uniqueness constraint look satisfied when
    // it is only untested.
    const skus = new Set(Array.from({ length: 20 }, (_, i) => makeProduct(i).sku));

    expect(skus.size).toBe(20);
  });

  it('carries accents and an apostrophe, which is the point of real fixtures', () => {
    /*
     * Not decoration. These are the characters that break naive encoding
     * detection and CSV quoting, and having them in the ordinary fixtures
     * means P1-17's bugs surface in every run rather than only in the suite
     * written to look for them.
     */
    const wineText = wineFixtures.map((wine) => `${wine.name} ${wine.producer}`).join(' ');

    expect(wineText).toContain('Àma');
    expect(wineText).toContain("Nero d'Avola");
    // And the tenant name too, so a suite that only seeds tenants still meets
    // a non-ASCII value.
    expect(makeTenant().name).toContain('Còlpetrone');
  });

  it('leaves some rows incomplete, so completeness scoring has range', () => {
    // P1-12 scores completeness. A fixture set where every row is complete
    // gives that function a single input and no way to fail.
    const incomplete = wineFixtures.filter((wine) => !wine.alcoholPct || !wine.foodPairings);

    expect(incomplete.length).toBeGreaterThan(0);
    expect(incomplete.length).toBeLessThan(wineFixtures.length);
  });
});

describe('makeMembership', () => {
  it('produces a row the contract accepts', () => {
    expect(membershipInsert.safeParse(makeMembership()).success).toBe(true);
  });

  it('does not look like a uuid', () => {
    // Better Auth ids are not UUIDs (P0-23). A uuid-shaped fixture would let a
    // stray `::uuid` cast pass every test and fail on the first real login.
    expect(makeMembership().userId).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe('makeTenantDomain', () => {
  it('produces a row the contract accepts', () => {
    expect(tenantDomainInsert.safeParse(makeTenantDomain()).success).toBe(true);
  });

  it('is already normalised, as the database CHECK requires', () => {
    // Lowercase scheme and host, no path, no trailing slash. A fixture that
    // was not normalised fails at insert and reads as a schema bug.
    const { origin } = makeTenantDomain();

    expect(origin).toBe(origin.toLowerCase());
    expect(origin.startsWith('https://')).toBe(true);
    expect(origin.endsWith('/')).toBe(false);
    expect(origin.slice('https://'.length)).not.toContain('/');
  });
});

describe('italianCsvFixture', () => {
  it('uses the delimiters an Italian spreadsheet actually exports', () => {
    // Semicolon-delimited with comma decimals is what Excel produces under an
    // Italian locale, and the combination P1-16's parser has to survive.
    const csv = italianCsvFixture();

    expect(csv.split('\n')[0]).toContain(';');
    expect(csv).toContain('42,00');
  });

  it('quotes a cell containing a comma', () => {
    /*
     * The case a naive split on `,` gets wrong. Kept in the shared fixture
     * rather than only in P1-15's table tests, so any parser written against
     * these fixtures meets it immediately.
     */
    expect(italianCsvFixture()).toContain('"Brasato al Barolo, ossobuco');
  });

  it('has one row per wine plus a header', () => {
    expect(italianCsvFixture().split('\n')).toHaveLength(wineFixtures.length + 1);
  });
});
