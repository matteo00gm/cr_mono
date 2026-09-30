import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CLAIM_SWEEPER_GUC,
  markClaimNotified,
  NestedClaimSweepContextError,
  readClaimWork,
} from '../src/claim-sweep.js';
import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { readServedClaims, withdrawClaim } from '../src/domain-claims.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The claim sweep's read and the holder's side of a claim, against real
 * Postgres (P4-18b, an amendment to ADR 0028).
 *
 * **The sweep's reach is a property of a policy**, so it is proved here and not
 * with a fake: the flag admits claims on notice and outcomes not yet told, from
 * every winery, and nothing else — not a claim awaiting its proof, not a claim
 * already told. And it buys a read: a write under the flag alone is refused.
 *
 * Seeding and reading go through the superuser, everything under test through
 * `app_rw` with no session GUC, for the reason `with-domain-claim.integration`
 * gives.
 */

let container: StartedPostgreSqlContainer | undefined;
let clients: DbClient[] = [];
let db: Database;
let adminDb: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  const runtime = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  const admin = createDbClient(started.adminUrl, { max: 1 });

  clients = [runtime, admin];
  db = runtime.db;
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await container?.stop();
}, 60_000);

type ClaimStatus = 'PENDING' | 'PROVEN' | 'NOTICE' | 'TRANSFERRED' | 'CANCELED';

const winery = async (): Promise<string> => {
  const id = randomUUID();

  await adminDb.execute(sql`
    INSERT INTO tenants (id, name, slug, status) VALUES (${id}::uuid, 'Cantina', ${`sweep-${id}`}, 'ACTIVE')
  `);

  return id;
};

const origin = (): string => `https://w${randomBytes(4).toString('hex')}.example`;

interface Seed {
  readonly status: ClaimStatus;
  readonly incumbent?: string | undefined;
  /** Seconds from now to the notice's deadline. */
  readonly dueInSec?: number | undefined;
  /** Which state has been told. */
  readonly notified?: ClaimStatus | undefined;
}

const claim = async (claimant: string, seed: Seed): Promise<string> => {
  const rows = await adminDb.execute(sql`
    INSERT INTO domain_claims (
      tenant_id, incumbent_tenant_id, origin, registrable_domain, status, transfer_at,
      notified_status, notified_at
    )
    VALUES (
      ${claimant}::uuid, ${seed.incumbent ?? null}::uuid, ${origin()}, 'example.com',
      ${seed.status}::domain_claim_status,
      ${seed.dueInSec === undefined ? null : sql`now() + make_interval(secs => ${seed.dueInSec})`},
      ${seed.notified ?? null}::domain_claim_status,
      ${seed.notified === undefined ? null : sql`now()`}
    )
    RETURNING id
  `);

  return ([...rows][0] as { id: string }).id;
};

const row = async (id: string) => {
  const rows = await adminDb.execute(sql`
    SELECT status, notified_status, notified_at IS NOT NULL AS notified,
           extract(epoch FROM transfer_at - now())::int AS due_in
    FROM domain_claims WHERE id = ${id}::uuid
  `);

  return [...rows][0] as {
    status: ClaimStatus;
    notified_status: ClaimStatus | null;
    notified: boolean;
    due_in: number | null;
  };
};

describe('the work the claim sweep can see', () => {
  it('finds a notice to send, a notice to settle and outcomes to tell, across wineries', async () => {
    const [a, b, holder] = [await winery(), await winery(), await winery()];
    const unsent = await claim(a, { status: 'NOTICE', incumbent: holder, dueInSec: 3600 });
    const due = await claim(b, {
      status: 'NOTICE',
      incumbent: holder,
      dueInSec: -1,
      notified: 'NOTICE',
    });
    const moved = await claim(a, { status: 'TRANSFERRED', incumbent: holder, notified: 'NOTICE' });
    const withdrawn = await claim(b, {
      status: 'CANCELED',
      incumbent: holder,
      notified: 'NOTICE',
    });

    const work = await readClaimWork(500, db);
    const byId = new Map(work.map((item) => [item.id, item]));

    expect(byId.get(unsent)).toMatchObject({ claimantTenantId: a, due: false, status: 'NOTICE' });
    expect(byId.get(due)).toMatchObject({ claimantTenantId: b, due: true });
    expect(byId.get(moved)).toMatchObject({
      status: 'TRANSFERRED',
      notifiedStatus: 'NOTICE',
      incumbentTenantId: holder,
    });
    expect(byId.get(withdrawn)).toMatchObject({ status: 'CANCELED' });
  });

  it.each<[string, Seed]>([
    ['a claim awaiting its proof', { status: 'PENDING' }],
    ['a proven claim the claimant is settling', { status: 'PROVEN' }],
    ['a notice sent and still running', { status: 'NOTICE', dueInSec: 3600, notified: 'NOTICE' }],
    ['an outcome already told', { status: 'TRANSFERRED', notified: 'TRANSFERRED' }],
  ])('leaves out %s', async (_label, seed) => {
    const claimant = await winery();
    const holder = await winery();
    const id = await claim(claimant, { incumbent: holder, ...seed });

    expect((await readClaimWork(500, db)).map((item) => item.id)).not.toContain(id);
  });

  it('reaches nothing more than its work, however it is asked', async () => {
    /* The bound is the policy's: under the flag alone, a statement asking for
     * every claim still gets only what the branch admits. */
    const [claimant, holder] = [await winery(), await winery()];
    const pending = await claim(claimant, { status: 'PENDING' });
    const told = await claim(claimant, {
      status: 'TRANSFERRED',
      incumbent: holder,
      notified: 'TRANSFERRED',
    });

    const seen = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config(${CLAIM_SWEEPER_GUC}, 'on', true)`);

      return [...(await tx.execute(sql`SELECT id FROM domain_claims`))].map(
        (item) => (item as { id: string }).id,
      );
    });

    expect(seen).not.toContain(pending);
    expect(seen).not.toContain(told);
  });

  it('buys a read and nothing more: a write under the flag alone is refused', async () => {
    const [claimant, holder] = [await winery(), await winery()];
    const id = await claim(claimant, { status: 'NOTICE', incumbent: holder, dueInSec: 60 });

    const error: unknown = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config(${CLAIM_SWEEPER_GUC}, 'on', true)`);
        await tx.execute(
          sql`UPDATE domain_claims SET status = 'TRANSFERRED' WHERE id = ${id}::uuid`,
        );
      })
      .catch((caught: unknown) => caught);

    expect((error as { cause?: { code?: string } }).cause?.code).toBe('42501');
    expect((await row(id)).status).toBe('NOTICE');
  });

  it('refuses to open inside a tenant context', async () => {
    const tenant = await winery();

    await expect(withTenant(tenant, () => readClaimWork(10, db), db)).rejects.toBeInstanceOf(
      NestedClaimSweepContextError,
    );
  });
});

describe('recording what was told', () => {
  it('starts a notice’s clock when it is sent, and stamps it once', async () => {
    /* The holder gets the whole notice from when it was told, not from when
     * the claim was proven — which may have been before any mail went out. */
    const [claimant, holder] = [await winery(), await winery()];
    const id = await claim(claimant, { status: 'NOTICE', incumbent: holder, dueInSec: 60 });

    const first = await withTenant(claimant, (tx) => markClaimNotified(tx, id, 'NOTICE', 72), db);
    const second = await withTenant(claimant, (tx) => markClaimNotified(tx, id, 'NOTICE', 72), db);
    const after = await row(id);

    expect(first).toBeInstanceOf(Date);
    expect(second).toBeUndefined();
    expect(after).toMatchObject({ notified_status: 'NOTICE', notified: true });
    expect(after.due_in).toBeGreaterThan(72 * 3600 - 60);
  });

  it('stamps nothing when the state moved on while the mail was going out', async () => {
    const [claimant, holder] = [await winery(), await winery()];
    const id = await claim(claimant, { status: 'CANCELED', incumbent: holder });

    await expect(
      withTenant(claimant, (tx) => markClaimNotified(tx, id, 'NOTICE', 72), db),
    ).resolves.toBeUndefined();
    expect((await row(id)).notified_status).toBeNull();
  });

  it('records an outcome without touching its deadline', async () => {
    const [claimant, holder] = [await winery(), await winery()];
    const id = await claim(claimant, { status: 'TRANSFERRED', incumbent: holder });

    await expect(
      withTenant(claimant, (tx) => markClaimNotified(tx, id, 'TRANSFERRED', 72), db),
    ).resolves.toBeNull();
    expect(await row(id)).toMatchObject({ notified_status: 'TRANSFERRED', due_in: null });
  });

  it('is the claimant’s to record, not the holder’s', async () => {
    const [claimant, holder] = [await winery(), await winery()];
    const id = await claim(claimant, { status: 'NOTICE', incumbent: holder, dueInSec: 60 });

    await expect(
      withTenant(holder, (tx) => markClaimNotified(tx, id, 'NOTICE', 72), db),
    ).resolves.toBeUndefined();
  });
});

describe('the holder’s side', () => {
  it('lists the notices served on it, and nothing it claimed itself', async () => {
    const [holder, claimant] = [await winery(), await winery()];
    const served = await claim(claimant, { status: 'NOTICE', incumbent: holder, dueInSec: 60 });
    await claim(holder, { status: 'NOTICE', incumbent: claimant, dueInSec: 60 });
    await claim(claimant, { status: 'CANCELED', incumbent: holder });

    const listed = await withTenant(holder, readServedClaims, db);

    expect(listed.map((item) => item.id)).toEqual([served]);
  });

  it('withdraws a notice served on it, and keeps the origin', async () => {
    const [holder, claimant] = [await winery(), await winery()];
    const id = await claim(claimant, { status: 'NOTICE', incumbent: holder, dueInSec: 60 });

    const withdrawn = await withTenant(holder, (tx) => withdrawClaim(tx, id), db);

    expect(withdrawn).toMatch(/^https:\/\/w[0-9a-f]{8}\.example$/u);
    expect((await row(id)).status).toBe('CANCELED');
  });

  it.each<[string, (holder: string, claimant: string) => Promise<[string, string]>]>([
    [
      'by the claimant',
      async (holder, claimant) => [
        await claim(claimant, { status: 'NOTICE', incumbent: holder, dueInSec: 60 }),
        claimant,
      ],
    ],
    [
      'once it has settled',
      async (holder, claimant) => [
        await claim(claimant, { status: 'TRANSFERRED', incumbent: holder }),
        holder,
      ],
    ],
    [
      'by a winery it was never served on',
      async (holder, claimant) => [
        await claim(claimant, { status: 'NOTICE', incumbent: holder, dueInSec: 60 }),
        await winery(),
      ],
    ],
  ])('cannot be withdrawn %s', async (_label, arrange) => {
    const [holder, claimant] = [await winery(), await winery()];
    const [id, actor] = await arrange(holder, claimant);
    const before = (await row(id)).status;

    await expect(withTenant(actor, (tx) => withdrawClaim(tx, id), db)).resolves.toBeUndefined();
    expect((await row(id)).status).toBe(before);
  });
});
