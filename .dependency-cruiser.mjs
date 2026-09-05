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
        // Both files, not just with-tenant.ts: P0-18 split the connection
        // factory out of P0-19's helper, so the driver legitimately lives in
        // client.ts too. What the rule protects is everything *outside* this
        // package reaching a connection without going through withTenant.
        // Tests are exempt: they are not a production path, and the RLS
        // integration suite has to drive a real connection to prove isolation.
        //
        // src/schema/ is exempt from P0-22 because table *declarations* are not
        // database access: `pgTable` describes a shape, it opens nothing. The
        // rule is about reaching a connection, and nothing under schema/ can.
        // Narrowed to that directory rather than to the package, so a future
        // file in packages/db/src that does open a connection is still caught.
        //
        // src/deploy.ts is exempt from P0-21b, and unlike schema/ it really
        // does open connections. The exemption is for what it connects *for*:
        // applying bootstrap and migrations, as the roles that own the schema,
        // before any tenant row exists. There is no tenant context to set and
        // no policy for one to satisfy — withTenant would have nothing to say.
        // Named as one file rather than a directory, so this stays a hole for
        // exactly the deploy path and not for whatever lands beside it.
        // packages/testing/src is exempt from P0-44, and the exemption is only
        // safe because of `no-testing-in-production` below. The harness starts
        // a container and hands tests a connection; it cannot do that through
        // withTenant, because half its job is proving what happens *without*
        // tenant context. What keeps this from being a hole is that no
        // production module may import the package at all — so the exemption
        // widens what test code can reach, not what ships.
        //
        // src/auth-db.ts is exempt from P0-45, and it is the file that *is* the
        // second sanctioned path: it hands Better Auth's adapter an un-scoped
        // connection. Exempt for the same reason as deploy.ts — there is no
        // tenant context to set, because authentication is what happens before
        // a tenant is known — and named as one file so this stays a hole for
        // exactly the auth adapter.
        //
        // packages/core/src/auth.ts is the single consumer of the
        // `@catalogorosso/db/auth` subpath, and the ONLY one. This is the
        // "tightly-scoped withTenant exception" P0-45 requires. Adding a second
        // file here should be treated as a design change, not a config tweak:
        // every additional name is another place a query can be issued with no
        // tenant, and the point of one sanctioned path is that there is one
        // thing to audit.
        pathNot:
          '^packages/db/src/(client|with-tenant|with-user|deploy|auth-db|memberships|audit)[.]ts$' +
          '|^packages/db/src/schema/' +
          '|^packages/testing/src/' +
          '|^packages/core/src/auth[.]ts$' +
          '|(^|/)test/',
      },
      to: {
        // `postgres` is postgres-js, the driver P0-18 actually chose. The
        // original pattern listed only `pg`, so it would have kept passing
        // while the real client was imported anywhere.
        //
        // `@catalogorosso/db/test-support` is the subpath that exposes the
        // connection factory for the harness, and `@catalogorosso/db/auth` the
        // one that exposes the un-scoped connection for the Better Auth
        // adapter. Both are listed here so reaching them is caught by the same
        // rule as reaching the driver directly — a narrowly-named escape is
        // only narrow if using it is checked. Without this line the `/auth`
        // subpath would be importable from anywhere, since the rule's targets
        // are the driver packages and `@catalogorosso/db` is not one of them.
        path:
          '(^|/)node_modules/(pg|postgres|drizzle-orm)(/|$)' +
          '|^(pg|postgres)($|/)' +
          '|^drizzle-orm($|/)' +
          '|^@catalogorosso/db/(test-support|auth)$',
      },
    },

    {
      // The companion to the packages/testing exemption above. Without it, that
      // exemption would let any module reach a raw connection by importing the
      // harness — the rule would be satisfied and the guarantee gone.
      //
      // Fixture data is the second reason: the factories carry Barolo and
      // Chianti rows that would be nonsense in a running system, and a
      // production import of them is a bug whether or not it opens a
      // connection.
      name: 'no-testing-in-production',
      severity: 'error',
      comment:
        'Production code must not import @catalogorosso/testing. It carries a container ' +
        'harness that opens un-scoped connections, and fixture data that has no meaning ' +
        'outside a test. Test files may import it freely.',
      from: {
        path: '^(apps|packages)/',
        pathNot: '(^|/)test/|^packages/testing/',
      },
      to: {
        path: '^packages/testing/|^@catalogorosso/testing($|/)',
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
    // `node_modules` is deliberately NOT excluded. `exclude` removes modules
    // from the graph entirely, which silently makes every rule targeting an
    // npm package unfireable — the raw-DB rule passed for exactly as long as
    // the driver was uninstalled. `doNotFollow` above already stops traversal
    // into them; they still need to appear as dependencies to be matched.
    exclude: { path: '(^|/)(dist|coverage)/' },
  },
};
