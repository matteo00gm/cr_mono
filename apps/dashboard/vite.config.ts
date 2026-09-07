import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

/**
 * The dashboard bundle (P0-57).
 *
 * A static SPA, not SSR (ADR 0005). It is an authenticated console behind a
 * login — nothing here is crawled, and nothing benefits from a server render —
 * so the cheap thing is also the right thing: files on S3 behind CloudFront,
 * with no runtime to keep alive (P0-58 deploys it).
 */
export default defineConfig({
  /*
   * `@preact/preset-vite` aliases `react` and `react-dom` to `preact/compat`,
   * which is what lets a React-only library work here without pulling React in
   * beside Preact. The repository runs **one** UI runtime on purpose
   * (§Repository Layout), and the alias is how that survives a dependency that
   * has not heard of Preact.
   */
  plugins: [preact()],

  build: {
    outDir: 'dist',
    /*
     * Source maps, and they ship. This is a first-party console: the bundle is
     * already readable, so withholding maps costs debuggability and protects
     * nothing. What must never reach it is a secret, and the API is what
     * enforces every rule the UI merely reflects (P0-49).
     */
    sourcemap: true,
    target: 'es2022',
  },

  server: {
    /*
     * `/v1` is proxied in development so the browser sees one origin and the
     * session cookie behaves the way it will in production, where CloudFront
     * puts the SPA and the API on the same host (P0-17a). Without this, local
     * development is a cross-origin cookie problem that production does not
     * have — and the workarounds for it tend to get committed.
     */
    proxy: { '/v1': { target: 'http://localhost:3001', changeOrigin: true } },
  },
});
