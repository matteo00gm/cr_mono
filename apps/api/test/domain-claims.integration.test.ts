import { randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';

import { readMembershipsForUser } from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createDomainsPort } from '../src/domains.js';
import { signedIn } from './support/auth.js';

/**
 * Claiming a held domain, end to end (P4-18).
 *
 * The HTTP routes, the real port and real Postgres, with only the session and
 * the nameserver faked — so what is proved is the whole path the row
 * describes: open a claim, publish its nonce, check it, and watch the origin
 * move, or the holder be put on notice, depending on who the holder is.
 *
 * The pieces are proved closer to where they live: the policy branch and every
 * kind of holder in `packages/db`'s `with-domain-claim.integration`, the port's
 * composition in `domain-claims-port.test`. This file is what shows they fit —
 * that the proof the port records is the one the claim scope accepts, and that
 * the scope runs outside any tenant transaction the request opened.
 */

let harness: TestDatabase | undefined;

const admin = () => {
  if (harness === undefined) throw new Error('no database');
  return harness.adminDb;
};

/** What the fake nameserver answers: every nonce published so far. */
const published: string[][] = [];

const winery = async (status: string): Promise<string> => {
  const id = randomUUID();

  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status, plan)
    VALUES (${id}, 'Cantina', ${`claim-${id}`}, ${status}::tenant_status, 'ECOMMERCE')
  `);

  return id;
};

const owner = async (tenantId: string): Promise<string> => {
  const id = `user_${randomUUID().slice(0, 8)}`;

  await admin().execute(sql`
    INSERT INTO auth_users (id, name, email, two_factor_enabled)
    VALUES (${id}, 'Anna', ${`${id}@example.test`}, true)
  `);
  await admin().execute(sql`
    INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenantId}, ${id}, 'OWNER')
  `);

  return id;
};

const appAs = (userId: string) =>
  createApp({
    auth: signedIn(userId),
    readMemberships: readMembershipsForUser,
    domains: createDomainsPort({
      environment: 'development',
      newResolver: () => () => Promise.resolve(published),
    }),
  });

const post = async (userId: string, path: string, body?: unknown) => {
  const response = await appAs(userId).request(`/v1/dashboard${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/** A winery holding an origin, and a second winery claiming it. */
const contest = async (holderStatus: string) => {
  const registrable = `c${randomBytes(4).toString('hex')}.example`;
  const origin = `https://www.${registrable}`;
  const holder = await winery(holderStatus);
  const claimant = await winery('ACTIVE');
  const claimantOwner = await owner(claimant);

  await admin().execute(sql`
    INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status)
    VALUES (${holder}, ${origin}, ${registrable}, 'VERIFIED')
  `);

  return { registrable, origin, holder, claimant, claimantOwner };
};

const holderOf = async (origin: string): Promise<string | undefined> => {
  const rows = await admin().execute(
    sql`SELECT tenant_id FROM tenant_domains WHERE origin = ${origin}`,
  );

  return ([...rows][0] as { tenant_id?: string } | undefined)?.tenant_id;
};

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('claiming a domain another winery holds', () => {
  it('is refused as unavailable to add, and pointed at the claim', async () => {
    const { origin, claimantOwner } = await contest('ACTIVE');

    const added = await post(claimantOwner, '/domains', { domain: origin });

    expect(added.status).toBe(409);
    expect(JSON.stringify(added.body)).toContain('claim it by proving you control its DNS');
  });

  it('moves at once from a winery that is switched off, once the record is there', async () => {
    const { origin, claimant, claimantOwner } = await contest('DISABLED');

    const opened = await post(claimantOwner, '/domains/claims', { domain: origin });
    const claim = opened.body.claim as { id: string; verificationToken: string };

    expect(opened.status).toBe(201);

    /* Not published yet: checked, refused, nothing moved. */
    const early = await post(claimantOwner, `/domains/claims/${claim.id}/verify`);

    expect(early.body).toMatchObject({ verified: false, transferred: false });
    expect(await holderOf(origin)).not.toBe(claimant);

    published.push([claim.verificationToken]);

    const checked = await post(claimantOwner, `/domains/claims/${claim.id}/verify`);

    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({
      verified: true,
      transferred: true,
      claim: { status: 'TRANSFERRED', verificationToken: null },
      domain: { origin, status: 'VERIFIED' },
    });
    expect(await holderOf(origin)).toBe(claimant);
  });

  it('puts a paying winery on notice and moves nothing, however often it is checked', async () => {
    const { origin, holder, claimantOwner } = await contest('ACTIVE');

    const opened = await post(claimantOwner, '/domains/claims', { domain: origin });
    const claim = opened.body.claim as { id: string; verificationToken: string };

    published.push([claim.verificationToken]);

    const checked = await post(claimantOwner, `/domains/claims/${claim.id}/verify`);
    const again = await post(claimantOwner, `/domains/claims/${claim.id}/verify`);

    expect(checked.body).toMatchObject({
      verified: true,
      transferred: false,
      claim: { status: 'NOTICE' },
    });
    expect(typeof checked.body.transferAt).toBe('string');
    expect(again.body).toMatchObject({ transferred: false, transferAt: checked.body.transferAt });
    expect(await holderOf(origin)).toBe(holder);

    /* And the answer names nobody: no holder id, anywhere in it. */
    expect(JSON.stringify(checked.body)).not.toContain(holder);
  });
});
