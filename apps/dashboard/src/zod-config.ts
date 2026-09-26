import { config } from 'zod';

/**
 * zod without its eval probe, so the dashboard runs clean under its CSP (P4-12).
 *
 * zod 4 compiles object parsers with `new Function` when it may, and finds out
 * whether it may by calling `Function('')` once. The dashboard's CSP has no
 * `unsafe-eval`, so the probe is refused — zod falls back correctly, but the
 * browser files a violation for every page load, and a CSP whose reports are
 * always full is a CSP nobody reads. `jitless` skips the probe.
 *
 * **Imported first in `main.tsx`, and it has to be.** The probe runs when a
 * schema is *constructed*, which happens as `@catalogorosso/api-client`
 * evaluates — before any code in `main.tsx` itself. Only a module earlier in
 * the import order runs sooner. The browser suite serves the built bundle under
 * the real CSP and fails on any violation, which is how this was found.
 */
config({ jitless: true });
