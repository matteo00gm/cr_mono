import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import type { ProductInsert } from '../src/contracts.js';
import { insertInvitation, markInvitationAccepted } from '../src/invitations.js';
import { insertProduct, reindexProduct, updateProduct } from '../src/products.js';
import { upsertProducts } from '../src/products-upsert.js';
import { withInvitation } from '../src/with-invitation.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createAuthUser, createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Four row locks, each proved to be taken where it is written (review).
 *
 * **A mutation run removed each and no test failed.** Every one guards the
 * window between a read and the write it decides — a lost update on an inline
 * edit, an import or a reindex; a second spend of one invitation — and that
 * window cannot be paused from outside the function to race it.
 *
 * So these ask Postgres instead. Another connection holds the row; the function
 * under test is started; `pg_stat_activity` says which statement it is waiting
 * in. **With the lock it waits in its `SELECT … FOR UPDATE`**, before reading
 * anything. Without it the read goes straight through and it waits later, in the
 * write — having already decided from a row somebody else is changing.
 */

let container: StartedPostgreSqlContainer | undefined;
let clients: DbClient[] = [];
let db: Database;
let seedDb: Database;
let adminDb: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  const app = createDbClient(started.roleUrl('app_rw'), { max: 2 });
  const seed = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  /* Two: one holds a row open in a transaction while the other watches. */
  const admin = createDbClient(started.adminUrl, { max: 2 });

  clients = [app, seed, admin];
  db = app.db;
  seedDb = seed.db;
  adminDb = admin.db;
  tenantId = await createTenant(seedDb, 'row-locks');
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await container?.stop();
}, 60_000);

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/**
 * Holds `lock` open on an admin connection until `release` settles. The admin
 * role bypasses RLS, so the lock needs no scope of its own.
 */
const holding = async (lock: ReturnType<typeof sql>) => {
  const locked = deferred();
  const release = deferred();
  const held = adminDb.transaction(async (tx) => {
    await tx.execute(lock);
    locked.resolve();
    await release.promise;
  });

  await locked.promise;

  return { release: release.resolve, held };
};

/** The statement a backend is blocked in, polled until one is. */
const waitingIn = async (): Promise<string> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = [
      ...(await adminDb.execute(sql`
        SELECT query FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active' AND pid <> pg_backend_pid()
      `)),
    ] as { query: string }[];

    if (row !== undefined) return row.query;

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  throw new Error('nothing blocked within five seconds');
};

/** Whether the blocked statement is a locking read, and not a write. */
const isLockingRead = (statement: string): boolean =>
  /^\s*select/iu.test(statement) && /for update/iu.test(statement);

const addWine = async (sku: string): Promise<string> => {
  const values = {
    sku,
    name: `Vino ${sku}`,
    wineType: 'red',
    priceCents: 2500,
    currency: 'EUR',
    stockStatus: 'IN_STOCK',
  } as ProductInsert;

  const created = await withTenant(
    tenantId,
    (tx) => insertProduct(tx, { tenantId, values, contentHash: `hash-${sku}` }),
    seedDb,
  );
  if (created.outcome !== 'created') throw new Error('seed failed');
  return created.product.id;
};

const lockProduct = (id: string) => sql`SELECT 1 FROM products WHERE id = ${id}::uuid FOR UPDATE`;

describe('an inline edit', () => {
  it('locks the row before it reads it, so two edits cannot merge onto one base', async () => {
    const id = await addWine('LOCK-EDIT');
    const { release, held } = await holding(lockProduct(id));

    const edit = withTenant(
      tenantId,
      (tx) =>
        updateProduct(tx, {
          productId: id,
          values: { priceCents: 3100 },
          hashOf: () => 'hash-edited',
        }),
      db,
    );

    const statement = await waitingIn();
    release();
    await held;
    await edit;

    expect(isLockingRead(statement), statement).toBe(true);
  });
});

describe('a reindex', () => {
  it('locks the row before it reads the state it will write over', async () => {
    const id = await addWine('LOCK-REINDEX');
    const { release, held } = await holding(lockProduct(id));

    const reindex = withTenant(
      tenantId,
      (tx) =>
        reindexProduct(tx, {
          productId: id,
          nextStatus: (current) => ({ ...current, embeddingState: 'PENDING' }),
          reason: 'reindex',
        }),
      db,
    );

    const statement = await waitingIn();
    release();
    await held;
    await reindex;

    expect(isLockingRead(statement), statement).toBe(true);
  });
});

describe('an import', () => {
  it('locks every existing row it will decide about before reading them', async () => {
    const sku = 'LOCK-IMPORT';
    await addWine(sku);
    const { release, held } = await holding(
      sql`SELECT 1 FROM products WHERE sku = ${sku} FOR UPDATE`,
    );

    const imported = withTenant(
      tenantId,
      (tx) =>
        upsertProducts(tx, {
          tenantId,
          rows: [
            {
              index: 0,
              values: {
                sku,
                name: 'Vino importato',
                wineType: 'red',
                priceCents: 2700,
                currency: 'EUR',
                stockStatus: 'IN_STOCK',
              },
            },
          ],
          hashOf: () => 'hash-imported',
          edited: (current) => current,
          reason: 'import',
        }),
      db,
    );

    const statement = await waitingIn();
    release();
    await held;
    await imported;

    expect(isLockingRead(statement), statement).toBe(true);
  });
});

describe('accepting an invitation', () => {
  it('locks the invitation before reading it, so one token is spent once', async () => {
    /*
     * Without the lock two people racing on one link both read it open, and
     * both become members — a single-use token used twice.
     */
    const inviter = await createAuthUser(seedDb, 'inviter');
    const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');

    await withTenant(
      tenantId,
      (tx) =>
        insertInvitation(tx, {
          email: `guest-${randomUUID()}@cantina.example`,
          role: 'EDITOR',
          tokenHash,
          invitedBy: inviter,
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      seedDb,
    );

    const { release, held } = await holding(
      sql`SELECT 1 FROM invitations WHERE token_hash = ${tokenHash} FOR UPDATE`,
    );

    const accepted = withInvitation(
      tokenHash,
      (tx, invitation) => markInvitationAccepted(tx, invitation.id),
      db,
    );

    const statement = await waitingIn();
    release();
    await held;
    await accepted;

    expect(isLockingRead(statement), statement).toBe(true);
  });
});
