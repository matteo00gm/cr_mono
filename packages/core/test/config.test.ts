import { describe, expect, it, vi } from 'vitest';

import {
  createConfigLoader,
  MissingConfigError,
  parameterPath,
  type ParameterStore,
} from '../src/config.js';

const STAGE = 'dev';
const path = (name: string) => parameterPath(STAGE, name);

/**
 * Returns the store and its spy separately.
 *
 * Passing `store.get` straight to `expect` trips `unbound-method`, and the rule
 * is right: a detached method reference is the kind of thing that works until
 * the implementation starts using `this`.
 */
const storeReturning = (values: Record<string, string>) => {
  const get = vi.fn((): Promise<Record<string, string>> => Promise.resolve(values));
  const store: ParameterStore = { get };
  return { store, get };
};

describe('parameterPath', () => {
  it('namespaces by stage', () => {
    expect(parameterPath('prod', 'database/url')).toBe('/sommelier/prod/database/url');
  });
});

describe('createConfigLoader', () => {
  it('resolves every requested name', async () => {
    const { store } = storeReturning({ [path('a')]: 'one', [path('b')]: 'two' });
    const load = createConfigLoader(store, { stage: STAGE, names: ['a', 'b'] });

    await expect(load()).resolves.toEqual({ a: 'one', b: 'two' });
  });

  it('fails closed when a parameter is absent, naming the full path', async () => {
    const { store } = storeReturning({ [path('a')]: 'one' });
    const load = createConfigLoader(store, { stage: STAGE, names: ['a', 'b'] });

    // The property that matters: a denied or missing path must not arrive as
    // `undefined`, which callers tend to treat as "use a default".
    await expect(load()).rejects.toBeInstanceOf(MissingConfigError);
    await expect(load()).rejects.toThrow('/sommelier/dev/b');
  });

  it('treats a blank value as missing', async () => {
    const { store } = storeReturning({ [path('a')]: '' });
    const load = createConfigLoader(store, { stage: STAGE, names: ['a'] });

    await expect(load()).rejects.toBeInstanceOf(MissingConfigError);
  });

  it('reports every missing name at once, not just the first', async () => {
    const { store } = storeReturning({});
    const load = createConfigLoader(store, { stage: STAGE, names: ['a', 'b', 'c'] });

    await expect(load()).rejects.toSatisfy(
      (error: unknown) => error instanceof MissingConfigError && error.missing.length === 3,
    );
  });

  it('fetches once across repeated calls', async () => {
    const { store, get } = storeReturning({ [path('a')]: 'one' });
    const load = createConfigLoader(store, { stage: STAGE, names: ['a'] });

    await load();
    await load();

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('shares one fetch between concurrent cold-start callers', async () => {
    const { store, get } = storeReturning({ [path('a')]: 'one' });
    const load = createConfigLoader(store, { stage: STAGE, names: ['a'] });

    await Promise.all([load(), load(), load()]);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so a transient outage is retryable', async () => {
    let attempt = 0;
    const get = vi.fn((): Promise<Record<string, string>> => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('SSM unavailable'))
        : Promise.resolve({ [path('a')]: 'one' });
    });
    const store: ParameterStore = { get };
    const load = createConfigLoader(store, { stage: STAGE, names: ['a'] });

    await expect(load()).rejects.toThrow('SSM unavailable');
    // Caching the rejection would turn one blip into an outage lasting the
    // whole container lifetime.
    await expect(load()).resolves.toEqual({ a: 'one' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('returns a frozen object so a caller cannot mutate shared config', async () => {
    const { store } = storeReturning({ [path('a')]: 'one' });
    const load = createConfigLoader(store, { stage: STAGE, names: ['a'] });

    expect(Object.isFrozen(await load())).toBe(true);
  });
});
