/**
 * Architectural boundaries, enforced in CI (P0-09).
 *
 * These are the rules that lint cannot express and code review forgets. The
 * third one is the point of the whole file: it is what makes tenant isolation
 * structural rather than a convention people are trusted to remember.
 *
 * .mjs, not the .js the plan named: this package is "type": "module", so a
 * .js config is parsed as ESM and module.exports is not defined.
 */
export default {
  forbidden: [
    {
      name: 'no-packages-to-apps',
      severity: 'error',
      comment:
        'Dependencies flow packages -> apps, never back. A package that reaches into an app ' +
        'cannot be tested or reused without dragging that app in behind it.',
      from: { path: '^packages/' },
      to: {
        // Both spellings. A relative import resolves into apps/, but a
        // workspace-name import resolves to node_modules/@catalogorosso/api,
        // which '^apps/' never matches. ESLint's no-restricted-imports also
        // catches the second form and reports it earlier, in the editor; this
        // rule is here so the file that documents the architecture has no hole
        // in it.
        path:
          '^apps/' +
          '|(^|/)node_modules/@catalogorosso/(api|worker|dashboard|widget)(/|$)' +
          '|^@catalogorosso/(api|worker|dashboard|widget)($|/)',
      },
    },

    {
      name: 'no-framework-in-core-or-security',
      severity: 'error',
      comment:
        'packages/core and packages/security must stay free of HTTP and AWS so their tests ' +
        'run as plain unit tests. The moment security imports the AWS SDK, testing the CORS ' +
        'check or the token verifier needs a mocked cloud, and the T1-T10 matrix gets slower ' +
        'and less trusted every time it is touched.',
      from: { path: '^packages/(core|security)/' },
      to: {
        path: '(^|/)node_modules/(@aws-sdk|aws-sdk|hono)(/|$)|^(@aws-sdk/|aws-sdk$|hono($|/))',
      },
    },

    {
      name: 'no-raw-db-outside-with-tenant',
      severity: 'error',
      comment:
        'The raw Postgres pool and the un-scoped Drizzle client may only be imported by ' +
        'packages/db/src/with-tenant.ts. RLS policies read current_setting(app.tenant_id); a ' +
        'query issued outside withTenant carries no tenant context, so it either returns ' +
        'nothing or — once someone "fixes" that with a default — returns another tenant rows. ' +
        'One sanctioned path means one thing to audit. See P0-19.',
      from: {
        pathNot: '^packages/db/src/with-tenant[.]ts$',
      },
      to: {
        path: '(^|/)node_modules/(pg|drizzle-orm)(/|$)|^(pg$|pg/|drizzle-orm($|/))',
      },
    },

    {
      // Not in the original three. Cheap to add while the tool is already here,
      // and a cycle is the kind of thing that is trivial to prevent and
      // expensive to unpick once two modules have grown into each other.
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make initialisation order load-bearing and untestable.',
      from: {},
      to: { circular: true },
    },
  ],

  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    // Type-only imports are still architectural coupling: a package that
    // imports an app's types is still pointed the wrong way.
    tsPreCompilationDeps: true,
    exclude: { path: '(^|/)(dist|coverage|node_modules)/' },
  },
};
