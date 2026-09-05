import { describe, expect, it } from 'vitest';

import { handler } from '../src/index.js';

describe('api test wiring', () => {
  it('runs in the node environment, with no DOM in scope', () => {
    expect('document' in globalThis).toBe(false);
    expect('window' in globalThis).toBe(false);
  });
});

describe('the Lambda entry point', () => {
  it('exports a handler built at module load, not per invocation', () => {
    /*
     * Route registration is container-lifetime work, so `handle(createApp())`
     * runs once at import. Importing the module here is also what proves the
     * adapter is wired at all: a broken `hono/aws-lambda` import would
     * otherwise only surface on a deployed cold start, where the symptom is an
     * unhelpful `Runtime.ImportModuleError`.
     */
    expect(typeof handler).toBe('function');
  });
});
