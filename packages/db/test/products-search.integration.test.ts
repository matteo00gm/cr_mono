import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres, type TestPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The lexical search column and its indexes (P1-07).
 *
 * **Every assertion here is about a property that fails silently.** A stemmer
 * that is not running still returns rows — just fewer of them. An accent that
 * is not folded still matches the spelling somebody happened to type. An index
 * that is not used still returns the right answer, slowly. None of these breaks
 * anything visibly, and all of them make retrieval quietly worse for the half
 * of the query that is a grape or a producer name.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let started: TestPostgres;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  tenantId = await createTenant(db, 'search');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

const add = async (values: {
  sku: string;
  name: string;
  producer?: string;
  region?: string;
  denomination?: string;
  grapes?: string[];
}) => {
  await useTenant(db, tenantId);
  await db.execute(sql`
    insert into products
      (tenant_id, sku, name, producer, region, denomination, grape_varieties,
       wine_type, price_cents, currency, stock_status)
    values (
      ${tenantId}::uuid, ${values.sku}, ${values.name}, ${values.producer ?? null},
      ${values.region ?? null}, ${values.denomination ?? null},
      ${values.grapes === undefined ? null : sql`${values.grapes}::text[]`},
      'red', 1000, 'EUR', 'IN_STOCK'
    )
  `);
};

/** SKUs whose `search_tsv` matches the query, in rank order. */
const search = async (query: string): Promise<string[]> => {
  await useTenant(db, tenantId);
  const rows = await db.execute(sql`
    select sku
    from products
    where search_tsv @@ websearch_to_tsquery('italian', immutable_unaccent(${query}))
    order by ts_rank_cd(search_tsv, websearch_to_tsquery('italian', immutable_unaccent(${query}))) desc
  `);

  return [...rows].map((row) => (row as { sku: string }).sku);
};

describe('the generated column', () => {
  it('is maintained by the database, not by the application', async () => {
    await add({ sku: 'GEN-1', name: 'Barolo Bussia', producer: 'Poderi Colla' });

    /*
     * Generated rather than trigger-maintained, and the difference is that a
     * generated column cannot drift: a trigger can be dropped, disabled or
     * skipped by a `COPY`, and the failure is invisible because the column
     * still exists and still holds whatever it last held.
     */
    await useTenant(db, tenantId);
    const rows = await db.execute(
      sql`select search_tsv::text as tsv from products where sku = 'GEN-1'`,
    );

    expect((([...rows][0] ?? {}) as { tsv: string }).tsv).toContain('barolo');
  });

  it('updates itself when the row changes', async () => {
    await add({ sku: 'GEN-2', name: 'Chianti Classico' });

    await useTenant(db, tenantId);
    await db.execute(sql`update products set name = 'Brunello di Montalcino' where sku = 'GEN-2'`);

    expect(await search('brunello')).toContain('GEN-2');
    expect(await search('chianti')).not.toContain('GEN-2');
  });
});

describe('italian stemming', () => {
  it('matches a plural against a singular, which is the whole point of a stemmer', async () => {
    /*
     * The plan's own example. With the `simple` configuration — which is what a
     * database built without the Italian dictionary would silently fall back to
     * — this returns nothing, and search just quietly finds less.
     */
    await add({ sku: 'STEM-1', name: 'Vino rosso della casa' });

    expect(await search('vini')).toContain('STEM-1');
  });

  it('matches across inflections of a real wine word', async () => {
    await add({ sku: 'STEM-2', name: 'Bottiglia magnum', producer: 'Cantina Sociale' });

    expect(await search('bottiglie')).toContain('STEM-2');
    expect(await search('cantine')).toContain('STEM-2');
  });

  it('ignores stop words rather than failing on them', async () => {
    await add({ sku: 'STEM-3', name: 'Rosso di Montepulciano' });

    // `di` is an Italian stop word; a query made only of stop words matches
    // nothing, and a query containing one must not be narrowed by it.
    expect(await search('rosso di montepulciano')).toContain('STEM-3');
  });
});

describe('accents', () => {
  it('finds an accented name from an unaccented query', async () => {
    /*
     * The reason `immutable_unaccent` exists at all. Italian visitors type both
     * forms, and an index that only matches the stored spelling is an index
     * that works for whoever entered the data.
     */
    await add({ sku: 'ACC-1', name: 'Nebbiòlo d’Alba', producer: 'Cantina Città' });

    expect(await search('nebbiolo')).toContain('ACC-1');
    expect(await search('citta')).toContain('ACC-1');
  });

  it('finds an unaccented name from an accented query', async () => {
    await add({ sku: 'ACC-2', name: 'Nebbiolo Superiore' });

    expect(await search('nebbiòlo')).toContain('ACC-2');
  });
});

describe('what is searched, and what is not', () => {
  it('finds by producer, region, denomination and grape', async () => {
    await add({
      sku: 'FIELD-1',
      name: 'Etichetta Bianca',
      producer: 'Poderi Colla',
      region: 'Piemonte',
      denomination: 'Barbaresco DOCG',
      grapes: ['Nebbiolo', 'Barbera'],
    });

    for (const query of ['colla', 'piemonte', 'barbaresco', 'barbera']) {
      expect(await search(query), `searching for ${query}`).toContain('FIELD-1');
    }
  });

  it('ranks a name match above a denomination match', async () => {
    /*
     * The weights are a decision, not decoration: somebody typing "barolo" is
     * far more likely to mean the wine called Barolo than every wine whose
     * denomination happens to mention it — and there are a lot of the latter.
     */
    await add({ sku: 'RANK-NAME', name: 'Barolo Bussia', producer: 'Colla' });
    await add({ sku: 'RANK-DEN', name: 'Etichetta Rossa', denomination: 'Barolo DOCG' });

    const results = await search('barolo');

    expect(results.indexOf('RANK-NAME')).toBeLessThan(results.indexOf('RANK-DEN'));
  });

  it('does not search the SKU, which is a warehouse code', async () => {
    await add({ sku: 'ZZTOP-999', name: 'Vino Anonimo' });

    /*
     * A SKU in the search vector is noise that retrieval has to work around —
     * and it is also the field most likely to collide with a real word. The
     * catalogue grid can filter on it directly.
     */
    expect(await search('zztop')).not.toContain('ZZTOP-999');
  });
});

describe('the indexes', () => {
  /**
   * Enough rows and real statistics, which is what it takes for a plan to be
   * evidence of anything.
   *
   * `ANALYZE` needs table ownership, so it runs as `app_migrate` — and that
   * connection needs its own tenant context, because `FORCE ROW LEVEL SECURITY`
   * applies to the owner too. That is the point of `FORCE`.
   */
  beforeAll(async () => {
    const migrator = createDbClient(started.roleUrl('app_migrate'), { max: 1 });

    try {
      await useTenant(migrator.db, tenantId);
      await migrator.db.execute(sql`
        insert into products
          (tenant_id, sku, name, producer, region, grape_varieties,
           wine_type, price_cents, currency, stock_status)
        select ${tenantId}::uuid, 'BULK-' || g, 'Vino numero ' || g, 'Produttore ' || g,
               'Regione ' || g, array['Uva ' || g],
               'red', 1000, 'EUR', 'IN_STOCK'
        from generate_series(1, 3000) g
      `);
      await migrator.db.execute(sql`analyze products`);
    } finally {
      await migrator.close();
    }
  }, 120_000);

  const plan = async (statement: ReturnType<typeof sql>): Promise<string> => {
    await useTenant(db, tenantId);
    const rows = await db.execute(statement);
    return JSON.stringify([...rows][0]);
  };

  it('serves a text search from the GIN index rather than a scan', async () => {
    /*
     * **A silently unused index is a latency cliff nobody notices** until a
     * tenant with a real catalogue arrives: search keeps returning correct
     * results and simply gets slower, which reads as "the product feels slow"
     * rather than as a missing index.
     */
    const explained = await plan(sql`
      explain (format json)
      select id from products
      where search_tsv @@ websearch_to_tsquery('italian', 'nebbiolo')
    `);

    expect(explained).toContain('products_search_idx');
  });

  it('serves a grape containment query from the array GIN index', async () => {
    const explained = await plan(sql`
      explain (format json)
      select id from products where grape_varieties @> array['Nebbiolo']::text[]
    `);

    expect(explained).toContain('products_grapes_idx');
  });

  it('serves a misspelled producer from the trigram index', async () => {
    /*
     * The half stemming cannot help with: real visitors misspell producer names
     * constantly, and a tsquery for `Poderi Cola` matches nothing at all.
     */
    const explained = await plan(sql`
      explain (format json)
      select id from products
      where immutable_unaccent(coalesce(producer, '')) % 'Produttre 42'
    `);

    expect(explained).toContain('products_producer_trgm_idx');
  });

  it('actually finds the misspelling, not merely a plan that could', async () => {
    await add({ sku: 'FUZZY-1', name: 'Barolo Bussia', producer: 'Poderi Colla' });

    await useTenant(db, tenantId);
    const rows = await db.execute(sql`
      select sku from products
      where immutable_unaccent(coalesce(producer, '')) % 'Poderi Cola'
    `);

    expect([...rows].map((row) => (row as { sku: string }).sku)).toContain('FUZZY-1');
  });
});
