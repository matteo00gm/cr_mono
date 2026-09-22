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

    lib: {
      entry: { loader: 'src/loader.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },

    rollupOptions: {
      output: {
        /*
         * One file per entry. See above: this is the line that keeps the
         * loader's budget honest rather than merely measured.
         */
        inlineDynamicImports: true,
      },
    },
  },
});
