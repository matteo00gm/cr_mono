import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ORIGIN_SECRET_HEADER } from '../src/middleware/origin-secret.js';

describe('api test wiring', () => {
  it('runs in the node environment, with no DOM in scope', () => {
    expect('document' in globalThis).toBe(false);
    expect('window' in globalThis).toBe(false);
  });
});

/*
 * The Lambda entry point, loaded the way Lambda loads it (P0-45, A2).
 *
 * `index.ts` does its whole job at module load: it reads the environment,
 * refuses a deployment that is missing something, and builds the handler once
 * per container. So every test here stubs the environment first and imports
 * the module afresh — `vi.resetModules()` is what makes each import a cold
 * start rather than a cache hit on the one before.
 *
 * A fake DATABASE_URL is enough because postgres-js is lazy: the clients are
 * constructed here, and no socket opens until a query is issued.
 */

/**
 * A minute per test rather than the default ten seconds.
 *
 * The first import is a cold load of the whole composition root — Better Auth,
 * drizzle, every route and every package they reach. Alone that is about two
 * seconds; under `test:coverage`, with v8 instrumenting every module and every
 * project running at once, it crossed ten and failed the entire run with a
 * timeout that looked like a broken entry point and was not one.
 */
const COLD_START_MS = 60_000;

/**
 * A local run. The last three are stubbed *empty* rather than left alone:
 * `index.ts` reads empty as absent, and a developer with `SST_STAGE` exported
 * in their shell would otherwise watch these fail for a reason that is not the
 * code.
 */
const LOCAL = {
  AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  AUTH_BASE_URL: 'https://dashboard.example.test',
  DATABASE_URL: 'postgres://app_rw:none@127.0.0.1:5432/none',
  SST_STAGE: '',
  ORIGIN_SECRET: '',
  RESEND_WEBHOOK_SECRET: '',
};

type Environment = Partial<Record<keyof typeof LOCAL, string>>;

type LambdaHandler = (
  event: unknown,
  context: unknown,
) => Promise<{ statusCode: number; body: string }>;

const load = async (environment: Environment) => {
  vi.resetModules();

  for (const [name, value] of Object.entries({ ...LOCAL, ...environment })) {
    vi.stubEnv(name, value);
  }

  // The same fresh instance `index.ts` is about to import, so a spy on it sees
  // what the entry point logs while it loads.
  const { logger } = await import('../src/middleware/logger.js');
  const warn = vi.spyOn(logger, 'warn');

  const entry = await import('../src/index.js');

  const warned = (): unknown[] =>
    (warn.mock.calls as unknown[][]).map(([fields]) => (fields as { kind?: unknown }).kind);

  return { handler: entry.handler as unknown as LambdaHandler, warned };
};

/** A Function URL request, payload format 2.0 — the shape `hono/aws-lambda` reads. */
const functionUrlEvent = (headers: Record<string, string> = {}) => ({
  version: '2.0',
  routeKey: '$default',
  rawPath: '/v1/dashboard',
  rawQueryString: '',
  headers: { host: 'api-example.lambda-url.eu-south-1.on.aws', ...headers },
  requestContext: {
    accountId: 'anonymous',
    apiId: 'api-example',
    domainName: 'api-example.lambda-url.eu-south-1.on.aws',
    domainPrefix: 'api-example',
    http: {
      method: 'GET',
      path: '/v1/dashboard',
      protocol: 'HTTP/1.1',
      sourceIp: '203.0.113.7',
      userAgent: 'vitest',
    },
    requestId: 'request-1',
    routeKey: '$default',
    stage: '$default',
    time: '14/Sep/2026:09:00:00 +0000',
    timeEpoch: 1_789_376_400_000,
  },
  isBase64Encoded: false,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the Lambda entry point', () => {
  it(
    'exports a handler built at module load, not per invocation',
    async () => {
      /*
       * Importing the module is also what proves the whole composition root is
       * wired: a broken `hono/aws-lambda` import, a Better Auth option the
       * library rejects, or a model name the drizzle adapter cannot resolve
       * would otherwise surface only on a deployed cold start, where the symptom
       * is an unhelpful `Runtime.ImportModuleError`.
       */
      const { handler } = await load({});

      expect(typeof handler).toBe('function');
    },
    COLD_START_MS,
  );

  it(
    'refuses to start without AUTH_SECRET, and says where the value lives',
    async () => {
      await expect(load({ AUTH_SECRET: '' })).rejects.toThrow('/sommelier/<stage>/auth/secret');
    },
    COLD_START_MS,
  );

  describe('on a deployed stage (A2)', () => {
    /*
     * `origin-secret.test.ts` proves the middleware refuses a request, by
     * handing `createApp` a secret directly — which says nothing about whether
     * the real entry point reads the variable, refuses to start without it, or
     * passes it on. Remove any one of those three steps and the API answers
     * callers who went around CloudFront and forged their client IP, with every
     * other test in the repository still green.
     */
    it(
      'refuses to start without the origin secret',
      async () => {
        await expect(load({ SST_STAGE: 'review' })).rejects.toThrow('ORIGIN_SECRET is not set');
      },
      COLD_START_MS,
    );

    it(
      'answers only requests that came through CloudFront',
      async () => {
        const secret = randomUUID();
        const { handler } = await load({ SST_STAGE: 'review', ORIGIN_SECRET: secret });

        const bypassed = await handler(functionUrlEvent(), {});
        const viaEdge = await handler(functionUrlEvent({ [ORIGIN_SECRET_HEADER]: secret }), {});

        expect(bypassed.statusCode).toBe(404);
        expect(viaEdge.statusCode).toBe(200);
        expect(JSON.parse(viaEdge.body) as unknown).toEqual({ surface: 'dashboard' });
      },
      COLD_START_MS,
    );

    it(
      'warns, rather than refusing to start, when the webhook signing secret is absent',
      async () => {
        /*
         * Absent here is restrictive — every delivery is refused — so what it
         * costs is an empty suppression list rather than a hole, and that is
         * said once per container instead of blocking the deploy (E7).
         */
        const { warned } = await load({ SST_STAGE: 'review', ORIGIN_SECRET: randomUUID() });

        expect(warned()).toContain('webhook_secret_absent');
      },
      COLD_START_MS,
    );

    it(
      'says nothing about the webhook secret once it is set',
      async () => {
        const { warned } = await load({
          SST_STAGE: 'review',
          ORIGIN_SECRET: randomUUID(),
          RESEND_WEBHOOK_SECRET: randomUUID(),
        });

        expect(warned()).not.toContain('webhook_secret_absent');
      },
      COLD_START_MS,
    );
  });
});
