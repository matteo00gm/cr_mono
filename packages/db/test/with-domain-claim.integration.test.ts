import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { CLAIM_GUC, NestedClaimContextError, settleDomainClaim } from '../src/with-domain-claim.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The eighth RLS scope, against real Postgres (P4-18, ADR 0028).
 *
 * **The branch is a property of a policy**, so none of it can be a unit test: a
 * fake returns whatever it is told to. Two things are proved here. That the
 * branch on `tenant_domains` reaches the one row a settleable claim names and
 * nothing else — not before the DNS proof, not while a notice has time left,
 * not for somebody else's claim. And that settling does what the row says to
 * each kind of holder: an abandoned or unverified one loses the origin at once,
 * a paying one is put on notice and keeps it.
 *
 * **Seeding and reading go through the superuser, settling never does.** `db`
 * is `app_rw` with no session GUC, so whatever it reaches, the policies let it
 * reach. A settlement run on the seeding connection would see through the
 * branch it is meant to be exercising.
 */

let container: StartedPostgreSqlContainer | undefined;
let clients: DbClient[] = [];
let db: Database;
let adminDb: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  const settler = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  const admin = createDbClient(started.adminUrl, { max: 1 });

  clients = [settler, admin];
  db = settler.db;
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await container?.stop();
}, 60_000);

type TenantStatus =
  'PENDING_VERIFICATION' | 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'DISABLED' | 'CANCELED';

type ClaimStatus = 'PENDING' | 'PROVEN' | 'NOTICE' | 'TRANSFERRED' | 'CANCELED';

const suffix = (): string => randomBytes(4).toString('hex');

/** What `core` hands the settlement; this package writes whatever it is given. */
const CLAIM_NOTICE_HOURS = 72;

const winery = async (status: TenantStatus = 'ACTIVE'): Promise<string> => {
  const id = randomUUID();

  await adminDb.execute(sql`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${id}::uuid, 'Cantina', ${`claims-${id}`}, ${status}::tenant_status)
  `);

  return id;
};

const member = async (): Promise<string> => {
  const id = `user_${suffix()}`;

  await adminDb.execute(sql`
    INSERT INTO auth_users (id, name, email) VALUES (${id}, 'Anna', ${`${id}@example.com`})
  `);

  return id;
};

/** A registrable domain and its apex and `www` origins, unique to one test. */
const zone = () => {
  const registrable = `w${suffix()}.example`;

  return {
    registrable,
    apex: `https://${registrable}`,
    www: `https://www.${registrable}`,
  };
};

const hold = async (
  tenantId: string,
  origin: string,
  registrable: string,
  status: 'PENDING' | 'VERIFIED' = 'VERIFIED',
): Promise<void> => {
  await adminDb.execute(sql`
    INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status)
    VALUES (${tenantId}::uuid, ${origin}, ${registrable}, ${status}::domain_status)
  `);
};

const claim = async (
  claimant: string,
  origin: string,
  registrable: string,
  status: ClaimStatus = 'PROVEN',
  notice?: { readonly incumbent: string; readonly dueInSec: number },
): Promise<string> => {
  const rows = await adminDb.execute(sql`
    INSERT INTO domain_claims (
      tenant_id, origin, registrable_domain, status, incumbent_tenant_id, transfer_at
    )
    VALUES (
      ${claimant}::uuid, ${origin}, ${registrable}, ${status}::domain_claim_status,
      ${notice?.incumbent ?? null}::uuid,
      ${notice === undefined ? null : sql`now() + make_interval(secs => ${notice.dueInSec})`}
    )
    RETURNING id
  `);

  return ([...rows][0] as { id: string }).id;
};

const holderOf = async (origin: string) => {
  const rows = await adminDb.execute(sql`
    SELECT tenant_id, status, verification_method FROM tenant_domains WHERE origin = ${origin}
  `);

  return [...rows][0] as
    { tenant_id: string; status: string; verification_method: string | null } | undefined;
};

const claimRow = async (id: string) => {
  const rows = await adminDb.execute(sql`
    SELECT status, incumbent_tenant_id, transfer_at, settled_at,
           extract(epoch FROM transfer_at - now())::int AS due_in
    FROM domain_claims WHERE id = ${id}::uuid
  `);

  return [...rows][0] as {
    status: ClaimStatus;
    incumbent_tenant_id: string | null;
    settled_at: Date | null;
    due_in: number | null;
  };
};

const auditOf = async (tenantId: string) => {
  const rows = await adminDb.execute(sql`
    SELECT action, target, actor_user_id, metadata FROM audit_log
    WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at, id
  `);

  return [...rows] as {
    action: string;
    target: string;
    actor_user_id: string | null;
    metadata: { kind?: string } | null;
  }[];
};

const cutoffFor = async (tenantId: string, origin: string) => {
  const rows = await adminDb.execute(sql`
    SELECT extract(epoch FROM now() - valid_from)::int AS age FROM widget_session_cutoffs
    WHERE tenant_id = ${tenantId}::uuid AND origin = ${origin}
  `);

  return [...rows][0] as { age: number } | undefined;
};

/** What `db` sees of an origin with the claim GUC set, as the named tenant. */
const visibleThroughClaim = async (
  claimId: string,
  origin: string,
  tenantId?: string,
): Promise<number> =>
  db.transaction(async (tx) => {
    if (tenantId !== undefined) {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    }
    await tx.execute(sql`SELECT set_config(${CLAIM_GUC}, ${claimId}, true)`);

    const rows = await tx.execute(sql`
      SELECT count(*)::int AS n FROM tenant_domains WHERE origin = ${origin}
    `);

    return ([...rows][0] as { n: number }).n;
  });

const settle = (claimId: string, claimantTenantId: string, cap = 2, userId?: string) =>
  settleDomainClaim(
    {
      claimId,
      claimantTenantId,
      cap,
      noticeHours: CLAIM_NOTICE_HOURS,
      actor: { userId, ip: '203.0.113.9', userAgent: 'test' },
    },
    db,
  );

describe('the branch a claim opens onto tenant_domains', () => {
  it('reaches the holder’s row once the claim is proven', async () => {
    const [holder, claimant] = [await winery(), await winery()];
    const { registrable, apex } = zone();
    await hold(holder, apex, registrable);
    const id = await claim(claimant, apex, registrable, 'PROVEN');

    expect(await visibleThroughClaim(id, apex, claimant)).toBe(1);
  });

  it.each<[ClaimStatus, string]>([
    ['PENDING', 'still waiting for its TXT record'],
    ['TRANSFERRED', 'already settled'],
    ['CANCELED', 'withdrawn by the holder'],
  ])('reaches nothing for a claim that is %s (%s)', async (status) => {
    const [holder, claimant] = [await winery(), await winery()];
    const { registrable, apex } = zone();
    await hold(holder, apex, registrable);
    const id = await claim(claimant, apex, registrable, status);

    expect(await visibleThroughClaim(id, apex, claimant)).toBe(0);
  });

  it('reaches nothing while a notice has time left, and the row once it has run out', async () => {
    /*
     * **The deadline is the policy's, not the caller's.** A sweep that ran
     * early, or a claimant pressing the button again, reaches nothing until the
     * holder's 72 hours are up — whatever the code asking believes the time is.
     */
    const [holder, claimant] = [await winery(), await winery()];
    const running = zone();
    const lapsed = zone();
    await hold(holder, running.apex, running.registrable);
    await hold(holder, lapsed.apex, lapsed.registrable);
    const early = await claim(claimant, running.apex, running.registrable, 'NOTICE', {
      incumbent: holder,
      dueInSec: 3600,
    });
    const due = await claim(claimant, lapsed.apex, lapsed.registrable, 'NOTICE', {
      incumbent: holder,
      dueInSec: -1,
    });

    expect(await visibleThroughClaim(early, running.apex, claimant)).toBe(0);
    expect(await visibleThroughClaim(due, lapsed.apex, claimant)).toBe(1);
  });

  it('reaches the one origin the claim names, not the rest of the holder’s', async () => {
    const [holder, claimant] = [await winery(), await winery()];
    const { registrable, apex, www } = zone();
    await hold(holder, apex, registrable);
    await hold(holder, www, registrable);
    const id = await claim(claimant, apex, registrable, 'PROVEN');

    expect(await visibleThroughClaim(id, www, claimant)).toBe(0);
  });

  it('reaches nothing for a claim the current tenant cannot see', async () => {
    /* The claim is read under its own policy, so naming somebody else's
     * proven claim — or naming one with no tenant set at all — opens nothing. */
    const [holder, claimant, stranger] = [await winery(), await winery(), await winery()];
    const { registrable, apex } = zone();
    await hold(holder, apex, registrable);
    const id = await claim(claimant, apex, registrable, 'PROVEN');

    expect(await visibleThroughClaim(id, apex, stranger)).toBe(0);
    expect(await visibleThroughClaim(id, apex)).toBe(0);
  });

  it('refuses to write the holder’s row, because WITH CHECK stays tenant-only', async () => {
    const [holder, claimant] = [await winery(), await winery()];
    const { registrable, apex } = zone();
    await hold(holder, apex, registrable);
    const id = await claim(claimant, apex, registrable, 'PROVEN');

    const error: unknown = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${claimant}, true)`);
        await tx.execute(sql`SELECT set_config(${CLAIM_GUC}, ${id}, true)`);
        await tx.execute(sql`UPDATE tenant_domains SET status = 'PENDING' WHERE origin = ${apex}`);
      })
      .catch((caught: unknown) => caught);

    expect((error as { cause?: { code?: string } }).cause?.code).toBe('42501');
  });
});

describe('the claims a holder can see and write', () => {
  it('shows a holder the claim once it is on notice, and not before', async () => {
    const [holder, claimant] = [await winery(), await winery()];
    const { registrable, apex } = zone();
    await claim(claimant, apex, registrable, 'PROVEN');
    await claim(claimant, zone().apex, registrable, 'NOTICE', { incumbent: holder, dueInSec: 60 });

    const seen = await withTenant(
      holder,
      async (tx) => [...(await tx.execute(sql`SELECT status FROM domain_claims`))],
      db,
    );

    expect(seen).toEqual([{ status: 'NOTICE' }]);
  });

  it('lets a holder withdraw a claim, and write nothing else', async () => {
    /*
     * **The holder's half of WITH CHECK admits a CANCELED row and nothing
     * else.** Withdrawing is the one thing a holder does to a claim; putting
     * it back to PROVEN, or writing a live claim naming somebody else as
     * claimant, is refused by the policy whatever the code asks for.
     */
    const [holder, claimant] = [await winery(), await winery()];
    const { registrable, apex } = zone();
    const id = await claim(claimant, apex, registrable, 'NOTICE', {
      incumbent: holder,
      dueInSec: 60,
    });

    const revive = await withTenant(
      holder,
      (tx) => tx.execute(sql`UPDATE domain_claims SET status = 'PROVEN' WHERE id = ${id}::uuid`),
      db,
    ).catch((caught: unknown) => caught);
    const forge = await withTenant(
      holder,
      (tx) =>
        tx.execute(sql`
          INSERT INTO domain_claims (tenant_id, incumbent_tenant_id, origin, registrable_domain, status)
          VALUES (${claimant}::uuid, ${holder}::uuid, ${zone().apex}, ${registrable}, 'PROVEN')
        `),
      db,
    ).catch((caught: unknown) => caught);

    expect((revive as { cause?: { code?: string } }).cause?.code).toBe('42501');
    expect((forge as { cause?: { code?: string } }).cause?.code).toBe('42501');

    await withTenant(
      holder,
      (tx) => tx.execute(sql`UPDATE domain_claims SET status = 'CANCELED' WHERE id = ${id}::uuid`),
      db,
    );

    expect((await claimRow(id)).status).toBe('CANCELED');
  });
});

describe('settling a claim', () => {
  it('lands an origin nobody holds with the claimant, verified', async () => {
    const claimant = await winery();
    const userId = await member();
    const { registrable, apex } = zone();
    const id = await claim(claimant, apex, registrable);

    const settled = await settle(id, claimant, 2, userId);

    expect(settled).toMatchObject({ kind: 'transferred', basis: 'unheld' });
    expect(await holderOf(apex)).toEqual({
      tenant_id: claimant,
      status: 'VERIFIED',
      verification_method: 'DNS_TXT',
    });
    expect((await claimRow(id)).status).toBe('TRANSFERRED');
    expect(await auditOf(claimant)).toEqual([
      {
        action: 'domain.claimed_by_challenge',
        target: apex,
        actor_user_id: userId,
        metadata: { kind: 'unheld' },
      },
    ]);
  });

  it.each<[TenantStatus, 'lapsed']>([
    ['DISABLED', 'lapsed'],
    ['CANCELED', 'lapsed'],
    ['PENDING_VERIFICATION', 'lapsed'],
  ])('moves the origin at once from a holder that is %s', async (status, basis) => {
    const [holder, claimant] = [await winery(status), await winery()];
    const userId = await member();
    const { registrable, apex, www } = zone();
    await hold(holder, apex, registrable);
    await hold(holder, www, registrable);
    const id = await claim(claimant, apex, registrable);

    const settled = await settle(id, claimant, 2, userId);

    expect(settled).toMatchObject({ kind: 'transferred', basis });
    expect((await holderOf(apex))?.tenant_id).toBe(claimant);
    /* Only the origin moves; the rest of the holder's zone stays put. */
    expect((await holderOf(www))?.tenant_id).toBe(holder);
    /* The holder's live sessions on it end now, and stay ended. */
    expect((await cutoffFor(holder, apex))?.age).toBeLessThan(60);
    /* Both audit logs, and the holder's names nobody from the claimant's side. */
    expect(await auditOf(holder)).toEqual([
      {
        action: 'domain.claimed_by_challenge',
        target: apex,
        actor_user_id: null,
        metadata: { kind: basis },
      },
    ]);
    expect(await auditOf(claimant)).toMatchObject([
      { action: 'domain.claimed_by_challenge', actor_user_id: userId },
    ]);
  });

  it('moves the origin at once when the holder never verified it', async () => {
    const [holder, claimant] = [await winery('ACTIVE'), await winery()];
    const { registrable, apex } = zone();
    await hold(holder, apex, registrable, 'PENDING');
    const id = await claim(claimant, apex, registrable);

    await expect(settle(id, claimant)).resolves.toMatchObject({
      kind: 'transferred',
      basis: 'unverified',
    });
    expect((await holderOf(apex))?.tenant_id).toBe(claimant);
  });

  it.each<TenantStatus>(['ACTIVE', 'TRIALING', 'PAST_DUE'])(
    'puts a holder that is %s on notice, and moves nothing',
    async (status) => {
      /*
       * **The safeguard the whole row turns on.** A hostile contractor, a
       * compromised registrar or a misconfigured shared zone can produce a
       * valid TXT record, and transferring a paying customer's origin on that
       * alone would kill a live widget without anybody being told.
       */
      const [holder, claimant] = [await winery(status), await winery()];
      const userId = await member();
      const { registrable, apex } = zone();
      await hold(holder, apex, registrable);
      const id = await claim(claimant, apex, registrable);

      const settled = await settle(id, claimant, 2, userId);

      expect(settled).toMatchObject({ kind: 'noticed' });
      expect(await holderOf(apex)).toMatchObject({ tenant_id: holder, status: 'VERIFIED' });
      expect(await cutoffFor(holder, apex)).toBeUndefined();

      const row = await claimRow(id);

      expect(row.status).toBe('NOTICE');
      expect(row.incumbent_tenant_id).toBe(holder);
      expect(row.due_in).toBeGreaterThan(CLAIM_NOTICE_HOURS * 3600 - 60);
      expect(row.due_in).toBeLessThanOrEqual(CLAIM_NOTICE_HOURS * 3600);
      expect(await auditOf(holder)).toEqual([
        {
          action: 'domain.claim_noticed',
          target: apex,
          actor_user_id: null,
          metadata: { kind: 'notice' },
        },
      ]);
      expect(await auditOf(claimant)).toMatchObject([
        { action: 'domain.claim_noticed', actor_user_id: userId },
      ]);
    },
  );

  it('moves the origin once the notice has run out on the holder it was served on', async () => {
    const [holder, claimant] = [await winery('ACTIVE'), await winery()];
    const { registrable, apex } = zone();
    await hold(holder, apex, registrable);
    const id = await claim(claimant, apex, registrable, 'NOTICE', {
      incumbent: holder,
      dueInSec: -1,
    });

    await expect(settle(id, claimant)).resolves.toMatchObject({
      kind: 'transferred',
      basis: 'notice-expired',
    });
    expect((await holderOf(apex))?.tenant_id).toBe(claimant);
  });

  it('serves a fresh notice on a new holder rather than spending the old one’s', async () => {
    /*
     * The first holder let the origin go while its notice ran, and somebody
     * else added it. That winery has been told nothing, and gets its own 72
     * hours rather than the last minute of somebody else's.
     */
    const [first, second, claimant] = [await winery(), await winery('ACTIVE'), await winery()];
    const { registrable, apex } = zone();
    await hold(second, apex, registrable);
    const id = await claim(claimant, apex, registrable, 'NOTICE', {
      incumbent: first,
      dueInSec: -1,
    });

    await expect(settle(id, claimant)).resolves.toMatchObject({ kind: 'noticed' });
    expect(await holderOf(apex)).toMatchObject({ tenant_id: second });

    const row = await claimRow(id);

    expect(row.incumbent_tenant_id).toBe(second);
    expect(row.due_in).toBeGreaterThan(CLAIM_NOTICE_HOURS * 3600 - 60);
  });

  it.each<[string, ClaimStatus, number | undefined]>([
    ['still waiting for its TXT record', 'PENDING', undefined],
    ['on notice with time left', 'NOTICE', 3600],
    ['withdrawn', 'CANCELED', undefined],
    ['already settled', 'TRANSFERRED', undefined],
  ])('does nothing with a claim %s', async (_label, status, dueInSec) => {
    const [holder, claimant] = [await winery('DISABLED'), await winery()];
    const { registrable, apex } = zone();
    await hold(holder, apex, registrable);
    const id = await claim(
      claimant,
      apex,
      registrable,
      status,
      dueInSec === undefined ? undefined : { incumbent: holder, dueInSec },
    );

    await expect(settle(id, claimant)).resolves.toEqual({ kind: 'unsettleable' });
    expect((await holderOf(apex))?.tenant_id).toBe(holder);
    expect((await claimRow(id)).status).toBe(status);
  });

  it('does nothing with a claim that is not the caller’s, or that was served on it', async () => {
    const [holder, claimant, stranger] = [await winery('DISABLED'), await winery(), await winery()];
    const { registrable, apex } = zone();
    await hold(holder, apex, registrable);
    const proven = await claim(claimant, apex, registrable);
    const served = await claim(claimant, zone().apex, registrable, 'NOTICE', {
      incumbent: holder,
      dueInSec: -1,
    });

    await expect(settle(proven, stranger)).resolves.toEqual({ kind: 'unsettleable' });
    await expect(settle(served, holder)).resolves.toEqual({ kind: 'unsettleable' });
    expect((await holderOf(apex))?.tenant_id).toBe(holder);
  });

  it('settles once, however often it is asked', async () => {
    const [holder, claimant] = [await winery('DISABLED'), await winery()];
    const { registrable, apex } = zone();
    await hold(holder, apex, registrable);
    const id = await claim(claimant, apex, registrable);

    const [one, two] = await Promise.all([settle(id, claimant), settle(id, claimant)]);

    expect([one.kind, two.kind].sort()).toEqual(['transferred', 'unsettleable']);
    expect(await auditOf(holder)).toHaveLength(1);
  });

  it('takes nothing from the holder when the claimant is at its plan cap', async () => {
    const [holder, claimant] = [await winery('DISABLED'), await winery()];
    const held = zone();
    const { registrable, apex } = zone();
    await hold(claimant, held.apex, held.registrable);
    await hold(holder, apex, registrable);
    const id = await claim(claimant, apex, registrable);

    await expect(settle(id, claimant, 1)).resolves.toEqual({ kind: 'at-cap', held: 1 });
    expect((await holderOf(apex))?.tenant_id).toBe(holder);
    expect((await claimRow(id)).status).toBe('PROVEN');
    expect(await auditOf(holder)).toEqual([]);
  });

  it('costs no slot when the claimant already holds the registrable domain', async () => {
    const [holder, claimant] = [await winery('DISABLED'), await winery()];
    const { registrable, apex, www } = zone();
    await hold(claimant, www, registrable);
    await hold(holder, apex, registrable);
    const id = await claim(claimant, apex, registrable);

    await expect(settle(id, claimant, 1)).resolves.toMatchObject({ kind: 'transferred' });
    expect((await holderOf(apex))?.tenant_id).toBe(claimant);
  });

  it('closes a claim on an origin the claimant has come to hold anyway', async () => {
    const claimant = await winery();
    const { registrable, apex } = zone();
    await hold(claimant, apex, registrable);
    const id = await claim(claimant, apex, registrable);

    await expect(settle(id, claimant, 0)).resolves.toMatchObject({
      kind: 'transferred',
      basis: 'already-held',
    });
    expect((await claimRow(id)).status).toBe('TRANSFERRED');
  });

  it('refuses to open inside a tenant context', async () => {
    const claimant = await winery();

    await expect(
      withTenant(claimant, () => settle(randomUUID(), claimant), db),
    ).rejects.toBeInstanceOf(NestedClaimContextError);
  });
});
