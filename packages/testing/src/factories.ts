import { randomUUID } from 'node:crypto';

import type {
  MembershipInsert,
  ProductInsert,
  TenantDomainInsert,
  TenantInsert,
} from '@catalogorosso/db';

/**
 * Fixture factories (P0-43).
 *
 * Every later suite needs two tenants with products, and writing that inline in
 * each one produces fixtures that drift apart and quietly stop covering the
 * same ground.
 *
 * **The fixtures are genuinely Italian, and that is load-bearing rather than
 * decorative.** Accented producers (`Còlpetrone`, `Feudo Montoni`), an
 * apostrophe in `Nero d'Avola`, and comma decimals in the CSV fixtures mean the
 * encoding and parsing bugs P1-17 exists to catch surface in ordinary test runs
 * rather than only in the suite written to look for them. A fixture set of
 * `Product 1`, `Product 2` would pass every test and prove nothing about the
 * catalogue this product actually serves.
 */

/** Types the factories accept: the contract shape, with everything optional. */
type Overrides<T> = Partial<T>;

/**
 * A tenant, with its id generated here.
 *
 * The id is returned rather than left to the database because P0-37 requires
 * it: `tenants` carries `WITH CHECK (id = app.tenant_id)`, so the caller has to
 * know the id *before* the insert in order to set the context the insert is
 * checked against. Signup has the same constraint.
 */
export const makeTenant = (
  overrides: Overrides<TenantInsert & { id: string }> = {},
): TenantInsert & { id: string } => {
  const id = overrides.id ?? randomUUID();

  return {
    id,
    name: 'Cantina Còlpetrone',
    // Unique by construction: a suite seeding several tenants must not collide
    // on the citext unique index, and a fixed slug plus a counter breaks as
    // soon as two suites run in the same container.
    slug: `cantina-${id}`,
    plan: null,
    locale: 'it',
    currency: 'EUR',
    ...overrides,
  };
};

/**
 * Real wines, with the properties that break naive parsers.
 *
 * `priceCentsRaw` carries the comma decimal a European spreadsheet exports, so
 * the CSV fixtures below are not a separate invention that could disagree with
 * these rows.
 *
 * Completeness is deliberately uneven — some have no `alcoholPct`, some no
 * `foodPairings` — so P1-12's scoring has range to measure. A fixture set where
 * every row is complete gives that function a single input.
 */
const WINES: readonly {
  sku: string;
  name: string;
  producer: string;
  wineType: string;
  priceCents: number;
  priceCentsRaw: string;
  grapeVarieties?: string[];
  foodPairings?: string[];
  alcoholPct?: string;
}[] = [
  {
    sku: 'BAROLO-2019',
    name: 'Barolo DOCG 2019',
    producer: 'Poderi Oddero',
    wineType: 'RED',
    priceCents: 4200,
    priceCentsRaw: '42,00',
    grapeVarieties: ['Nebbiolo'],
    foodPairings: ['Brasato al Barolo, ossobuco', 'Formaggi stagionati'],
    alcoholPct: '14.50',
  },
  {
    sku: 'CHIANTI-CL-2021',
    name: 'Chianti Classico DOCG 2021',
    producer: 'Castello di Àma',
    wineType: 'RED',
    priceCents: 1850,
    priceCentsRaw: '18,50',
    grapeVarieties: ['Sangiovese', 'Canaiolo'],
    foodPairings: ['Bistecca alla fiorentina'],
    alcoholPct: '13.50',
  },
  {
    sku: 'VERMENTINO-2023',
    name: 'Vermentino di Gallura DOCG 2023',
    producer: 'Cantina Gallura',
    wineType: 'WHITE',
    priceCents: 1420,
    priceCentsRaw: '14,20',
    grapeVarieties: ['Vermentino'],
    // No pairings and no alcohol: an incomplete row, on purpose.
  },
  {
    sku: 'NERO-AVOLA-2022',
    name: "Nero d'Avola Sicilia DOC 2022",
    producer: 'Feudo Montoni',
    wineType: 'RED',
    priceCents: 1690,
    priceCentsRaw: '16,90',
    grapeVarieties: ["Nero d'Avola"],
    foodPairings: ['Caponata', 'Pasta alla Norma'],
    alcoholPct: '13.00',
  },
];

/**
 * A product, cycling through the wines above.
 *
 * The index wraps, so a caller asking for twenty products gets varied rows
 * rather than twenty identical ones — the shape that makes a uniqueness
 * constraint look satisfied when it is only untested.
 */
export const makeProduct = (index = 0, overrides: Overrides<ProductInsert> = {}): ProductInsert => {
  const wine = WINES[index % WINES.length];

  if (!wine) {
    throw new Error('no wine fixtures defined');
  }

  return {
    sku: index < WINES.length ? wine.sku : `${wine.sku}-${String(index)}`,
    name: wine.name,
    producer: wine.producer,
    wineType: wine.wineType,
    priceCents: wine.priceCents,
    currency: 'EUR',
    stockStatus: 'IN_STOCK',
    grapeVarieties: wine.grapeVarieties ?? null,
    foodPairings: wine.foodPairings ?? null,
    alcoholPct: wine.alcoholPct ?? null,
    ...overrides,
  } as ProductInsert;
};

export const makeMembership = (overrides: Overrides<MembershipInsert> = {}): MembershipInsert => ({
  // Better Auth ids are not UUIDs (P0-23), so the fixture must not look like
  // one — a uuid here would let a `::uuid` cast slip through untested.
  userId: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
  role: 'OWNER',
  ...overrides,
});

export const makeTenantDomain = (
  overrides: Overrides<TenantDomainInsert> = {},
): TenantDomainInsert => ({
  // Already normalised: lowercase scheme and host, no path, no trailing slash.
  // The database CHECK rejects anything else, so a fixture that was not
  // normalised would fail at insert and read as a schema bug.
  origin: `https://cantina-${randomUUID().slice(0, 8)}.example`,
  registrableDomain: 'example.com',
  ...overrides,
});

/**
 * The CSV a seller actually exports from an Italian spreadsheet.
 *
 * Semicolon-delimited with comma decimals, which is what Excel produces under
 * an Italian locale — and the combination P1-16's parser has to survive. The
 * quoted pairing cell contains a comma of its own, which is the case a naive
 * split on `,` gets wrong and a delimited-string implementation gets wrong
 * twice.
 */
export const italianCsvFixture = (): string => {
  const header = 'sku;name;producer;wine_type;price;alcohol;food_pairings';
  const rows = WINES.map((wine) =>
    [
      wine.sku,
      wine.name,
      wine.producer,
      wine.wineType,
      wine.priceCentsRaw,
      wine.alcoholPct ?? '',
      `"${(wine.foodPairings ?? []).join(', ')}"`,
    ].join(';'),
  );

  return [header, ...rows].join('\n');
};

/** Every wine fixture, for suites that want to assert across the set. */
export const wineFixtures = WINES;
