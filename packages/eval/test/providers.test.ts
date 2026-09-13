import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EvalConfigError, providerFromEnv } from '../src/providers.js';

/** What `pnpm eval` reads from the shell that starts it (P1-46), and what it refuses to guess. */

describe('providerFromEnv', () => {
  it.each([
    ['nova', {}, 'bedrock:'],
    ['gemini', { GEMINI_API_KEY: randomUUID() }, 'gemini:'],
    ['anthropic', { ANTHROPIC_API_KEY: randomUUID() }, 'anthropic:'],
  ])('builds the %s adapter for the model it is given', (kind, keys, prefix) => {
    expect(providerFromEnv({ EVAL_PROVIDER: kind, EVAL_MODEL: 'm-1', ...keys }).id).toBe(
      `${prefix}m-1`,
    );
  });

  it.each([
    ['EVAL_PROVIDER', { EVAL_MODEL: 'm-1' }],
    ['EVAL_MODEL', { EVAL_PROVIDER: 'gemini' }],
    ['GEMINI_API_KEY', { EVAL_PROVIDER: 'gemini', EVAL_MODEL: 'm-1' }],
    ['ANTHROPIC_API_KEY', { EVAL_PROVIDER: 'anthropic', EVAL_MODEL: 'm-1', ANTHROPIC_API_KEY: '' }],
  ])('stops before spending anything when %s is missing', (name, env) => {
    expect(() => providerFromEnv(env)).toThrow(new EvalConfigError(`${name} is not set`));
  });

  it('names the providers it knows when given another', () => {
    expect(() => providerFromEnv({ EVAL_PROVIDER: 'openai', EVAL_MODEL: 'm-1' })).toThrow(
      'EVAL_PROVIDER must be one of: nova, gemini, anthropic',
    );
  });
});
