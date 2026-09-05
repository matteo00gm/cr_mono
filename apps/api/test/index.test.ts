import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('api test wiring', () => {
  it('runs in the node environment, with no DOM in scope', () => {
    expect('document' in globalThis).toBe(false);
    expect('window' in globalThis).toBe(false);
  });
});

describe('the Lambda entry point', () => {
  /*
   * Imported dynamically, after the environment is stubbed.
   *
   * `index.ts` is the composition root: it reads AUTH_SECRET and AUTH_BASE_URL
   * and builds the real Better Auth instance at module load, which is what a
   * Lambda container wants — route registration and adapter construction are
   * init-phase work, not per-invocation work. A static import would run all of
   * that before `vi.stubEnv` had a chance to run.
   *
   * A fake DATABASE_URL is enough because postgres-js is lazy: the client is
   * constructed here, and no socket is opened until a query is issued.
   */
  let handler: unknown;

  beforeAll(async () => {
    vi.stubEnv('AUTH_SECRET', 'test-secret-not-used-to-sign-anything-real');
    vi.stubEnv('AUTH_BASE_URL', 'https://dashboard.example.test');
    vi.stubEnv('DATABASE_URL', 'postgres://app_rw:none@127.0.0.1:5432/none');

    ({ handler } = await import('../src/index.js'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('exports a handler built at module load, not per invocation', () => {
    /*
     * Importing the module is also what proves the whole composition root is
     * wired: a broken `hono/aws-lambda` import, a Better Auth option the
     * library rejects, or a model name the drizzle adapter cannot resolve would
     * otherwise surface only on a deployed cold start, where the symptom is an
     * unhelpful `Runtime.ImportModuleError`.
     */
    expect(typeof handler).toBe('function');
  });
});
