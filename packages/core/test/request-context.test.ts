import { describe, expect, it } from 'vitest';

import {
  getRequestActor,
  getRequestContext,
  runWithRequestContext,
  setRequestTenant,
  setRequestUser,
} from '../src/request-context.js';

/**
 * The request context (P0-55, moved here by P0-53).
 *
 * It lives in this package because `audit()` records the actor, ip and
 * user-agent of whoever performed an action — and P0-52's last-OWNER guard and
 * every other domain rule needs to write audit rows, none of which can import
 * an app. Nothing here is HTTP-specific: the API fills it from a request, and
 * the worker will fill it from an SQS message.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('scoping', () => {
  it('makes the context visible to anything the callback awaits', () => {
    // The entire reason for AsyncLocalStorage: a repository function five
    // layers down, which has never heard of HTTP, can still say which request
    // it is serving without a parameter threaded into every signature.
    runWithRequestContext({ requestId: 'r1' }, () => {
      expect(getRequestContext()?.requestId).toBe('r1');
    });
  });

  it('is absent outside a context', () => {
    /*
     * `undefined`, not a throw. Migrations, the worker and this suite all run
     * outside a request, and a context accessor that threw there would turn a
     * background job into an outage.
     */
    expect(getRequestContext()).toBeUndefined();
  });

  it('keeps two overlapping contexts apart', async () => {
    /*
     * Why this is not a module-level variable. Lambda handles one request per
     * container at a time, but `sst dev` and this suite do not — and a shared
     * mutable global would attribute one tenant's actions to another the first
     * time two overlapped. That bug never reproduces locally.
     */
    const seen: Record<string, string | undefined> = {};

    const run = (id: string, tenant: string): Promise<void> =>
      runWithRequestContext({ requestId: id }, async () => {
        setRequestTenant(tenant);
        await Promise.resolve();
        seen[id] = getRequestContext()?.tenantId;
      });

    await Promise.all([run('a', TENANT), run('b', '22222222-2222-2222-2222-222222222222')]);

    expect(seen).toEqual({ a: TENANT, b: '22222222-2222-2222-2222-222222222222' });
  });
});

describe('setters', () => {
  it('report that they did nothing outside a context', () => {
    // A no-op rather than an error, for the same reason the accessor returns
    // undefined — but it says so, so a caller that genuinely requires context
    // can check rather than assume.
    expect(setRequestTenant(TENANT)).toBe(false);
    expect(setRequestUser('user_1')).toBe(false);
  });

  it('report success inside one', () => {
    runWithRequestContext({ requestId: 'r1' }, () => {
      expect(setRequestTenant(TENANT)).toBe(true);
      expect(setRequestUser('user_1')).toBe(true);
    });
  });

  it('mutate in place, so what came before stays untagged', () => {
    /*
     * Tenant resolution reads `memberships` *after* authentication (P0-47), so
     * the first part of a request legitimately has no tenant. Tagging it
     * retroactively would be a tidier record and a false one.
     */
    runWithRequestContext({ requestId: 'r1' }, () => {
      expect(getRequestActor().tenantId).toBeUndefined();
      setRequestTenant(TENANT);
      expect(getRequestActor().tenantId).toBe(TENANT);
    });
  });
});

describe('getRequestActor', () => {
  it('reads all four fields the audit row needs', () => {
    runWithRequestContext({ requestId: 'r1', ip: '203.0.113.7', userAgent: 'Firefox/1' }, () => {
      setRequestTenant(TENANT);
      setRequestUser('user_matteo');

      expect(getRequestActor()).toEqual({
        tenantId: TENANT,
        userId: 'user_matteo',
        ip: '203.0.113.7',
        userAgent: 'Firefox/1',
      });
    });
  });

  it('returns every field undefined outside a context, rather than throwing', () => {
    // `audit()` turns the missing tenant into a named error of its own, which
    // reads better at the call site than an accessor exploding here.
    expect(getRequestActor()).toEqual({
      tenantId: undefined,
      userId: undefined,
      ip: undefined,
      userAgent: undefined,
    });
  });

  it('leaves ip and user agent absent when the request did not carry them', () => {
    /*
     * `audit_log.ip` is `inet` and refuses a malformed address at write time,
     * so an absent header must stay absent. A row recording a guessed address
     * is worse than one recording none.
     */
    runWithRequestContext({ requestId: 'r1' }, () => {
      setRequestTenant(TENANT);

      expect(getRequestActor().ip).toBeUndefined();
      expect(getRequestActor().userAgent).toBeUndefined();
    });
  });
});
