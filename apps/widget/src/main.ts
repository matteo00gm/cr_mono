import { readConfig } from './bootstrap.js';
import { lazyPanel } from './lazy.js';
import { attach, start } from './loader.js';

/**
 * The script a seller pastes, as it actually runs (P3-01 → P3-04).
 *
 * **This is the published `loader.js`**, and it is the only module here with
 * side effects: everything it calls is a function that takes what it needs and
 * returns. That is what makes the rest testable without a page.
 *
 * The order is §1.2's, and each step earns the next:
 *
 * 1. **Mount the launcher.** Synchronous, so `document.currentScript` is still
 *    the tag the seller pasted.
 * 2. **Read the config.** One request, edge-cached for a minute. A tenant who
 *    switched the widget off stops here and costs nothing more (P3-03).
 * 3. **Wire the launcher.** The widget bundle is fetched on the first click,
 *    so a page nobody opens costs one small script (P3-04).
 */

/** Each step, injectable, so the order can be asserted without a browser. */
export interface Deps {
  readonly start?: typeof start | undefined;
  readonly readConfig?: typeof readConfig | undefined;
  readonly lazyPanel?: typeof lazyPanel | undefined;
  readonly attach?: typeof attach | undefined;
}

/**
 * Mount, read, wire — §1.2's order, with each step earning the next.
 *
 * Exported so it can be driven with a stand-in for each of them. It still runs
 * on import, at the foot of this file, because that is what a `<script>` tag
 * does — and with no `data-key` on the page it stops at the first line, which
 * is what it does on any page that has not pasted the snippet.
 */
export const run = (deps: Deps = {}): void => {
  const {
    start: start_ = start,
    readConfig: readConfig_ = readConfig,
    lazyPanel: lazyPanel_ = lazyPanel,
    attach: attach_ = attach,
  } = deps;
  const mounted = start_();

  if (mounted === undefined) return;

  const sommelier = globalThis.__sommelier;

  if (sommelier === undefined) return;

  void readConfig_({ api: sommelier.api, key: sommelier.key }).then((state) => {
    /*
     * **A tenant who is not serving gets no listener at all**, which is the
     * cheapest possible form of P3-03's short-circuit: not only is the bundle
     * never fetched, there is nothing that could fetch it. §1.3's disabled
     * notice is P3-07's, and it renders from the config this already holds.
     */
    if (state.kind !== 'active') {
      mounted.launcher.setAttribute('aria-disabled', 'true');

      return;
    }

    const lazy = lazyPanel_({
      shadow: mounted.shadow,
      launcher: mounted.launcher,
      config: state.config,
      api: sommelier.api,
      key: sommelier.key,
    });

    attach_(mounted.launcher, {
      onPress: () => {
        void lazy.toggle();
      },
      onHover: lazy.preload,
    });
  });
};

run();
