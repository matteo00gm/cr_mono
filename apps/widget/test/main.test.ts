import type { WidgetConfigResponse } from '@catalogorosso/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { run } from '../src/main.js';
import type { Mounted } from '../src/loader.js';

/**
 * The script as it actually runs (P3-01 -> P3-04).
 *
 * **What is asserted here is the order, and what each step buys.** Every piece
 * is tested where it lives; this is the composition, and the composition is
 * where §1.2's promises are kept or lost: a config read before the launcher
 * exists, a bundle fetched for a tenant who switched the widget off, a listener
 * attached to something that was never mounted.
 */

const config: WidgetConfigResponse = {
  status: 'ACTIVE',
  locale: 'it',
  theme: { primaryColor: '#7b1e3c', position: 'bottom-right', avatarUrl: null },
  welcomeMessage: 'Posso consigliarle un vino?',
  cartUrl: 'https://cantina-rossi.example/cart',
  quotaState: 'ok',
};

let mounted: Mounted;

const mountedNow = (): Mounted => {
  const host = document.createElement('sommelier-widget');
  const shadow = host.attachShadow({ mode: 'open' });
  const launcher = document.createElement('button');

  launcher.type = 'button';
  shadow.append(launcher);
  document.body.append(host);

  return { host, shadow, launcher };
};

beforeEach(() => {
  document.body.replaceChildren();
  globalThis.__sommelier = { key: 'pk_test_abc', api: 'https://api.example', mounted: true };
  mounted = mountedNow();
});

const lazy = () => ({ toggle: vi.fn(() => Promise.resolve()), preload: vi.fn(), loads: () => 0 });

describe('a tenant who is serving', () => {
  it('mounts, reads, then wires — in that order', async () => {
    const order: string[] = [];
    const attach = vi.fn(() => {
      order.push('attach');
    });

    run({
      start: () => {
        order.push('start');

        return mounted;
      },
      readConfig: () => {
        order.push('read');

        return Promise.resolve({ kind: 'active' as const, config });
      },
      lazyPanel: () => lazy(),
      attach,
    });

    await Promise.resolve();

    expect(order).toEqual(['start', 'read', 'attach']);
  });

  it('asks for the key and the API the loader captured', async () => {
    const readConfig = vi.fn(() => Promise.resolve({ kind: 'active' as const, config }));

    run({ start: () => mounted, readConfig, lazyPanel: () => lazy(), attach: vi.fn() });
    await Promise.resolve();

    expect(readConfig).toHaveBeenCalledWith({ api: 'https://api.example', key: 'pk_test_abc' });
  });

  it('wires the press to the toggle and the hover to the preload', async () => {
    const panel = lazy();
    let behaviour: { onPress: () => void; onHover?: (() => void) | undefined } | undefined;

    run({
      start: () => mounted,
      readConfig: () => Promise.resolve({ kind: 'active' as const, config }),
      lazyPanel: () => panel,
      attach: (_launcher, given) => {
        behaviour = given;
      },
    });

    await Promise.resolve();
    behaviour?.onPress();
    behaviour?.onHover?.();

    expect(panel.toggle).toHaveBeenCalledTimes(1);
    expect(panel.preload).toHaveBeenCalledTimes(1);
  });
});

describe('a tenant who switched the widget off', () => {
  it('gets no listener at all, so nothing could fetch the bundle', async () => {
    /*
     * **The cheapest possible form of P3-03's short-circuit.** Not only is the
     * bundle never fetched: there is nothing on the page that could fetch it.
     */
    const attach = vi.fn();
    const lazyPanel = vi.fn(() => lazy());

    run({
      start: () => mounted,
      readConfig: () => Promise.resolve({ kind: 'disabled' as const, config }),
      lazyPanel,
      attach,
    });

    await Promise.resolve();

    expect(attach).not.toHaveBeenCalled();
    expect(lazyPanel).not.toHaveBeenCalled();
  });

  it('says so on the launcher', async () => {
    run({
      start: () => mounted,
      readConfig: () => Promise.resolve({ kind: 'disabled' as const, config }),
      lazyPanel: () => lazy(),
      attach: vi.fn(),
    });

    await Promise.resolve();

    expect(mounted.launcher.getAttribute('aria-disabled')).toBe('true');
  });

  it('treats a config that could not be read the same way', async () => {
    const attach = vi.fn();

    run({
      start: () => mounted,
      readConfig: () => Promise.resolve({ kind: 'error' as const }),
      lazyPanel: () => lazy(),
      attach,
    });

    await Promise.resolve();

    expect(attach).not.toHaveBeenCalled();
  });
});

describe('a page that never mounted', () => {
  it('reads no config, because there is nothing to configure', async () => {
    // A snippet with no key, a document with no body, a second copy of the
    // script: each returns undefined from `start`, and none should cost a
    // request to a seller's visitors.
    const readConfig = vi.fn(() => Promise.resolve({ kind: 'active' as const, config }));

    run({ start: () => undefined, readConfig, lazyPanel: () => lazy(), attach: vi.fn() });
    await Promise.resolve();

    expect(readConfig).not.toHaveBeenCalled();
  });

  it('reads no config when the global is missing', async () => {
    globalThis.__sommelier = undefined;

    const readConfig = vi.fn(() => Promise.resolve({ kind: 'active' as const, config }));

    run({ start: () => mounted, readConfig, lazyPanel: () => lazy(), attach: vi.fn() });
    await Promise.resolve();

    expect(readConfig).not.toHaveBeenCalled();
  });
});
