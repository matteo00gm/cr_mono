/**
 * The widget's own entry (P3-04, §1.2).
 *
 * **Everything the loader does not carry.** It is fetched the first time a
 * visitor clicks the launcher, and never on the overwhelming majority of pages
 * where nobody does — which is what keeps a seller's Core Web Vitals untouched
 * and a page view free.
 *
 * P3-06 fills the panel with the chat; this is the seam the loader imports.
 */
export { mountPanel } from './panel.js';
export type { Panel, PanelOptions } from './panel.js';
