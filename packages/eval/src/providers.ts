import type { LlmProvider } from '@catalogorosso/core';
import { anthropicProvider, bedrockNovaProvider, geminiProvider } from '@catalogorosso/llm';

export const EVAL_PROVIDERS = ['nova', 'gemini', 'anthropic'] as const;

export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const required = (env: Env, name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new EvalConfigError(`${name} is not set`);
  return value;
};

/**
 * The provider a real run uses, from the shell that started it (P1-46).
 *
 * `pnpm eval` is run by a person, locally, with their own credentials, so this
 * is the one place in the eval package that reads the environment — and it
 * refuses to guess. No provider, model or key has a default: a run with any of
 * them missing stops here, before it spends anything. Nova uses the AWS
 * credential chain, as any local AWS tool does.
 */
export const providerFromEnv = (env: Env): LlmProvider => {
  const kind = required(env, 'EVAL_PROVIDER');
  const model = required(env, 'EVAL_MODEL');

  switch (kind) {
    case 'nova':
      return bedrockNovaProvider({ modelId: model });
    case 'gemini':
      return geminiProvider({ model, apiKey: required(env, 'GEMINI_API_KEY') });
    case 'anthropic':
      return anthropicProvider({ model, apiKey: required(env, 'ANTHROPIC_API_KEY') });
    default:
      throw new EvalConfigError(`EVAL_PROVIDER must be one of: ${EVAL_PROVIDERS.join(', ')}`);
  }
};
