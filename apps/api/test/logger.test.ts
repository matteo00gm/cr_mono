import {
  getRequestContext,
  runWithRequestContext,
  setRequestTenant,
  setRequestUser,
  type RequestContext,
} from '@catalogorosso/core';
import { Hono } from 'hono';
import { pino, type Logger, type LoggerOptions } from 'pino';
import { describe, expect, it } from 'vitest';

import { loggerOptions, requestContext } from '../src/middleware/logger.js';

/**
 * Structured logging (P0-55).
 *
 * These assertions run a *real* pino logger built from the exported options,
 * writing into an array. Spying on the logger's methods would prove a call
 * happened; it would not prove `mixin` put the tenant on the line, which is the
 * only property here worth having.
 */

interface Line {
  readonly requestId?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly level: number;
  readonly msg: string;
  readonly route?: string;
  readonly status?: number;
  readonly durationMs?: number;
}

const capturing = (): { lines: Line[]; log: Logger } => {
  const lines: Line[] = [];
  // Annotated rather than inferred: pino infers its custom-level generic from
  // the options object, and a bare `level: 'trace'` widens it to
  // `Logger<string>`, which is then not assignable to the plain `Logger` that
  // `requestContext` takes.
  const options: LoggerOptions = {
    ...loggerOptions,
    // So a suite assertion never depends on the LOG_LEVEL of the environment
    // it happens to run in.
    level: 'trace',
  };
  const log = pino(options, {
    write: (chunk: string) => lines.push(JSON.parse(chunk) as Line),
  });

  return { lines, log };
};

describe('the context mixin', () => {
  it('puts the request id on every line, with no call site knowing about it', () => {
    /*
     * The entire reason the AsyncLocalStorage exists. A repository function
     * five layers down that has never heard of HTTP still emits lines tagged
     * with the request that caused them — without a logger threaded through
     * every signature, which works right up until the one function nobody
     * threaded it into is the one that fails.
     */
    const { lines, log } = capturing();

    runWithRequestContext({ requestId: 'req-1' }, () => {
      log.info('deep inside');
    });

    expect(lines[0]).toMatchObject({ requestId: 'req-1', msg: 'deep inside' });
  });

  it('adds the tenant from the moment it is resolved, and not before', () => {
    /*
     * Tenant resolution reads `memberships` *after* authentication (P0-47), so
     * the first lines of a request legitimately have no tenant. Tagging them
     * retroactively would be a nicer-looking log and a false one — this asserts
     * the record stays honest about what was known when.
     */
    const { lines, log } = capturing();

    runWithRequestContext({ requestId: 'req-2' }, () => {
      log.info('before resolution');
      setRequestTenant('11111111-1111-1111-1111-111111111111');
      setRequestUser('user_abc');
      log.info('after resolution');
    });

    expect(lines[0]?.tenantId).toBeUndefined();
    expect(lines[0]?.userId).toBeUndefined();
    expect(lines[1]).toMatchObject({
      tenantId: '11111111-1111-1111-1111-111111111111',
      userId: 'user_abc',
    });
  });

  it('logs outside a request without failing', () => {
    /*
     * The worker, migrations and this suite all run outside a request. A mixin
     * that threw there would turn a background job into an outage, so the
     * absence of context is a normal state rather than an error.
     */
    const { lines, log } = capturing();

    log.info('no request here');

    expect(lines[0]?.requestId).toBeUndefined();
    expect(lines[0]?.msg).toBe('no request here');
  });

  it('keeps two overlapping requests apart', () => {
    /*
     * Why this is AsyncLocalStorage and not a module-level variable. Lambda
     * handles one request per container at a time, but `sst dev` and this suite
     * do not — and a shared mutable global would attribute one tenant's log
     * lines to another the first time two requests overlap. That bug never
     * reproduces locally and is unfalsifiable in production.
     */
    const { lines, log } = capturing();

    const request = async (id: string, tenant: string): Promise<void> =>
      runWithRequestContext({ requestId: id }, async () => {
        setRequestTenant(tenant);
        await Promise.resolve();
        log.info('done');
      });

    return Promise.all([
      request('a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      request('b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
    ]).then(() => {
      const byId: Record<string, string | undefined> = {};
      for (const line of lines) byId[line.requestId ?? 'none'] = line.tenantId;

      expect(byId).toEqual({
        a: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        b: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      });
    });
  });
});

describe('setRequestTenant / setRequestUser outside a request', () => {
  it('report that they did nothing rather than throwing', () => {
    expect(setRequestTenant('11111111-1111-1111-1111-111111111111')).toBe(false);
    expect(setRequestUser('user_abc')).toBe(false);
  });

  it('report success inside one', () => {
    runWithRequestContext({ requestId: 'req-3' }, () => {
      expect(setRequestTenant('11111111-1111-1111-1111-111111111111')).toBe(true);
      expect(setRequestUser('user_abc')).toBe(true);
    });
  });
});

describe('the client address, for audit rows', () => {
  const contextFor = async (headers: Record<string, string>): Promise<RequestContext> => {
    let captured: RequestContext | undefined;
    const app = new Hono();
    app.use('*', requestContext());
    app.get('/', (c) => {
      captured = getRequestContext();
      return c.text('ok');
    });

    await app.request('/', { headers });

    return captured ?? { requestId: 'none' };
  };

  it('keeps a single well-formed address', async () => {
    expect((await contextFor({ 'x-forwarded-for': '203.0.113.7' })).ip).toBe('203.0.113.7');
  });

  it('drops a multi-entry header rather than guessing which hop is the client', async () => {
    /*
     * The same problem P0-46 records against the rate limiter: without knowing
     * which hops are ours, no entry in the list is trustworthy. `audit_log.ip`
     * is `inet` and a row recording a guessed address is worse than one
     * recording none — so this resolves to nothing.
     */
    expect(
      (await contextFor({ 'x-forwarded-for': '203.0.113.7, 198.51.100.2' })).ip,
    ).toBeUndefined();
  });

  it('drops a value that is not an address at all', async () => {
    // The `inet` column would refuse it at write time, loudly, in the middle of
    // an unrelated action.
    expect((await contextFor({ 'x-forwarded-for': 'not-an-address' })).ip).toBeUndefined();
  });

  it('leaves it absent when the header is missing', async () => {
    expect((await contextFor({})).ip).toBeUndefined();
  });

  it('records the user agent when there is one, and nothing when there is not', async () => {
    expect((await contextFor({ 'user-agent': 'Firefox/1' })).userAgent).toBe('Firefox/1');
    expect((await contextFor({})).userAgent).toBeUndefined();
  });
});

describe('the completion line', () => {
  const served = async (path: string, register: (app: Hono) => void): Promise<Line[]> => {
    const { lines, log } = capturing();
    const app = new Hono();
    app.use('*', requestContext(log));
    register(app);
    await app.request(path);
    return lines;
  };

  it('records method, status and duration', async () => {
    const lines = await served('/v1/thing', (app) => {
      app.get('/v1/thing', (c) => c.text('ok'));
    });

    expect(lines[0]).toMatchObject({ msg: 'request', status: 200 });
    expect(lines[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('groups by route template rather than by URL', async () => {
    /*
     * `/v1/products/:id`, not `/v1/products/9f2c…`. The raw URL makes every
     * request its own unique string, so any aggregate query over the logs is
     * useless — and it puts resource ids into the log line as a side effect.
     */
    const lines = await served('/v1/products/9f2c', (app) => {
      app.get('/v1/products/:id', (c) => c.text('ok'));
    });

    expect(lines[0]?.route).toBe('/v1/products/:id');
  });

  it('carries the request id it generated', async () => {
    const lines = await served('/v1/thing', (app) => {
      app.get('/v1/thing', (c) => c.text('ok'));
    });

    expect(lines[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is emitted for a 404 as well as a 200', async () => {
    // Requests that matched no route are exactly the ones someone is trying to
    // account for later; a completion line only on success hides them.
    const lines = await served('/v1/missing', () => undefined);

    expect(lines[0]).toMatchObject({ msg: 'request', status: 404 });
  });
});
