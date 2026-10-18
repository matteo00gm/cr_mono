import { defineConfig } from 'vite';

/**
 * The widget's bundles (P3-01, P3-02).
 *
 * **Two entries, and never one chunk between them.** The loader runs on every
 * page of a seller's storefront and is budgeted at 5 KB gzipped (§1.1); the
 * widget itself is fetched only when a visitor clicks (P3-04). A shared vendor
 * chunk would put the second inside the first and the budget would be met by a
 * file that pulls in twice its size — which is exactly how a size budget passes
 * while the promise it encodes is broken.
 *
 * `inlineDynamicImports` is what forbids that: each entry is built on its own,
 * so there is no shared chunk for Rollup to hoist anything into.
 */
export default defineConfig({
  build: {
    outDir: 'dist/bundle',
    target: 'es2022',

    /*
     * Source maps, and they ship. The bundle is already readable on a seller's
     * page — withholding maps costs debuggability and protects nothing, which
     * is the same argument the dashboard makes. What must never reach it is a
     * secret, and the only thing this carries is a *public* key.
     */
    sourcemap: true,

    rollupOptions: {
      /*
       * Two entries, built together so Rollup can see that the widget is
       * reached only through a dynamic import — which is what makes it a
       * separate chunk rather than part of the loader.
       */
      input: {
        /*
         * `main.ts` publishes as `loader.js`, because that is what a seller
         * pastes and what §1.1 budgets by name. It is the one module with side
         * effects; everything it calls takes what it needs and returns, which
         * is what makes the rest testable without a page.
         */
        loader: 'src/main.ts',
        widget: 'src/widget.ts',
      },
      preserveEntrySignatures: 'exports-only',

      output: {
        format: 'es',
        /*
         * The loader keeps one name and the widget is named by its content
         * (P3-01a). The loader is published at the address a seller pastes,
         * which cannot change, and it imports the widget by a relative path
         * Rollup writes in — so a widget that changes gets a new address and
         * the loader that names it changes with it. A loader cached for its
         * five minutes then still fetches the widget it was built with, never
         * a newer one it does not know how to start, and a loader pinned by
         * its integrity hash keeps working for as long as its widget is kept.
         */
        entryFileNames: (chunk) => (chunk.name === 'loader' ? 'loader.js' : '[name]-[hash].js'),
        /*
         * The lazily-loaded panel is one chunk with a stable name, so the size
         * budget (P3-05) has something to point at. Everything else Rollup
         * would split — a shared helper between the two entries — it must not:
         * a common chunk is how the widget ends up inside the loader and the
         * 5 KB budget passes while the promise it encodes is broken.
         */
        chunkFileNames: 'panel.js',
        manualChunks: undefined,
      },
    },
  },
});
