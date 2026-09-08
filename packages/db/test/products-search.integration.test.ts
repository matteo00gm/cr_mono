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
      ${values.grapes === undefined ? null : `{${values.grapes.join(',')}}`}::text[],
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
    where search_tsv @@ websearch_to_tsquery('italian', ${query})
    order by ts_rank_cd(search_tsv, websearch_to_tsquery('italian', ${query})) desc
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

    /*
     * `barol`, not `barolo`: the column stores *lexemes*, and the Italian
     * stemmer is what turns one into the other. Asserting the word would pass
     * against a `simple` configuration and fail against the one we want, which
     * is precisely backwards.
     */
    expect((([...rows][0] ?? {}) as { tsv: string }).tsv).toContain('barol');
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

describe('accents, and what replaced the folding', () => {
  /**
   * **The plan asks for accent-insensitivity via `unaccent`, and Postgres will
   * not have it here.** `unaccent()` is STABLE, a SQL wrapper marked IMMUTABLE
   * is either inlinable (and exposes it) or carries a `SET` clause (and is
   * refused anyway), and PostgreSQL's own C-function recipe needs superuser —
   * which `app_migrate` is not, and which RDS's master is not either (P0-21b).
   *
   * So the stored vector keeps the accents, and the accented spelling becomes a
   * *fuzzy* match instead of an exact one. That is a real degradation, and
   * these tests state it rather than hide it: the text search misses, and the
   * trigram fallback (P1-08) catches it — which the API reports honestly as
   * `matchedBy: 'similar'` rather than passing it off as an exact hit.
   */
  it('does not match an accented name from an unaccented query', async () => {
    await add({ sku: 'ACC-1', name: 'Nebbiòlo d’Alba' });

    expect(await search('nebbiolo')).not.toContain('ACC-1');
  });

  it('finds it by similarity instead, which is where accents now land', async () => {
    await add({ sku: 'ACC-2', name: 'Nebbiòlo Superiore' });

    await useTenant(db, tenantId);
    const rows = await db.execute(sql`
      select sku from products where name % 'Nebbiolo Superiore'
    `);

    expect([...rows].map((row) => (row as { sku: string }).sku)).toContain('ACC-2');
  });

  it('still matches the spelling as entered', async () => {
    await add({ sku: 'ACC-3', name: 'Nebbiòlo Classico' });

    expect(await search('nebbiòlo')).toContain('ACC-3');
  });
});

describe('what is searched, and what is not', () => {
  it('finds by producer, region and denomination', async () => {
    await add({
      sku: 'FIELD-1',
      name: 'Etichetta Bianca',
      producer: 'Poderi Colla',
      region: 'Piemonte',
      denomination: 'Barbaresco DOCG',
      grapes: ['Nebbiolo', 'Barbera'],
    });

    for (const query of ['colla', 'piemonte', 'barbaresco']) {
      expect(await search(query), `searching for ${query}`).toContain('FIELD-1');
    }
  });

  it('does not find by grape, which is a containment query instead', async () => {
    /*
     * **The reduction Postgres forced, asserted rather than left implicit.**
     * `array_to_string` is STABLE — it calls the element type's output function
     * — so the array cannot be folded into a generated column, and the same
     * three dead ends as `unaccent` apply (P1-07). Grapes are queried through
     * the array GIN index instead, which is containment: the right question for
     * "does this wine include Nebbiolo", and what P1-09's filter uses.
     */
    await add({ sku: 'FIELD-2', name: 'Etichetta Rossa', grapes: ['Barbera'] });

    expect(await search('barbera')).not.toContain('FIELD-2');

    await useTenant(db, tenantId);
    const rows = await db.execute(
      sql`select sku from products where grape_varieties @> array['Barbera']::text[]`,
    );
    expect([...rows].map((row) => (row as { sku: string }).sku)).toContain('FIELD-2');
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
   * **Their existence is asserted; their *use* is not, and that is a
   * concession worth writing down.**
   *
   * The obvious test is an `EXPLAIN` showing the index in the plan, because a
   * silently unused index is a latency cliff nobody notices — retrieval keeps
   * returning correct results and simply gets slower. Three attempts at it
   * failed, and the planner was right every time: at a few thousand rows the
   * whole table is a handful of pages, so a sequential scan genuinely beats a
   * GIN bitmap scan's startup cost. Seeding enough rows to reverse that would
   * mean a catalogue far larger than the ~2,500 SKUs per tenant §5.0 plans for
   * — the assertion would then be about a table this product does not have.
   *
   * So this checks the migration created them, and the question of whether they
   * are *used* at real scale belongs to **P7-05**'s retrieval headroom check,
   * which exists for exactly that.
   */
  it.each([
    ['products_search_idx', 'the text search'],
    ['products_grapes_idx', 'grape containment'],
    ['products_name_trgm_idx', 'misspelled names'],
    ['products_producer_trgm_idx', 'misspelled producers'],
  ])('created %s, for %s', async (index) => {
    await useTenant(db, tenantId);
    const rows = await db.execute(
      sql`select indexname from pg_indexes where tablename = 'products' and indexname = ${index}`,
    );

    expect([...rows]).toHaveLength(1);
  });

  it('actually finds a misspelling, which is what the trigram index is for', async () => {
    await add({ sku: 'FUZZY-1', name: 'Barolo Bussia', producer: 'Poderi Colla' });

    await useTenant(db, tenantId);
    const rows = await db.execute(sql`
      select sku from products where coalesce(producer, '') % 'Poderi Cola'
    `);

    expect([...rows].map((row) => (row as { sku: string }).sku)).toContain('FUZZY-1');
  });

  it('actually answers a grape containment query', async () => {
    await add({ sku: 'GRAPE-1', name: 'Vino Rosso', grapes: ['Nebbiolo', 'Barbera'] });

    await useTenant(db, tenantId);
    const rows = await db.execute(
      sql`select sku from products where grape_varieties @> array['Nebbiolo']::text[]`,
    );

    expect([...rows].map((row) => (row as { sku: string }).sku)).toContain('GRAPE-1');
  });
});
