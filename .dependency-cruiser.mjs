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
        //
        // src/email-suppressions.ts is exempt from P0-64 on the same terms as
        // audit.ts and memberships.ts: it imports `sql` to write a statement
        // and takes the connection from its caller, opening nothing. It is
        // listed separately because the reason it is *safe* differs — the table
        // it touches has no tenant_id and no RLS policy, so there is no scoped
        // read for a missing context to silently narrow, and no other tenant's
        // rows for one to widen into.
        //
        // src/with-invitation.ts is exempt from P0-51, and it is the *third*
        // RLS context rather than an escape from one. It opens a transaction,
        // so unlike the two files below it really does reach a connection —
        // and the exemption is for the same reason `with-user.ts` has one: the
        // acceptance path has to read `invitations` before the caller is a
        // member of the tenant, because becoming one is what the request does.
        // Everything it can see is still under a policy; the scope is a
        // 256-bit token instead of a tenant id, and the tenant is then set
        // from the row Postgres matched. A fourth context appearing here
        // should be treated as a design change.
        //
        // src/invitations.ts and src/users.ts are exempt on the same terms as
        // audit.ts: they import `sql` to write statements and take the
        // connection from their caller, opening nothing.
        //
        // src/with-outbox.ts is exempt from P1-31, and it is the fourth RLS
        // context the note above says should be treated as a design change. It
        // was: ADR 0021 records it. What it is not is a fifth un-scoped path —
        // everything it reaches is still under a policy — but it is the first
        // context here that *widens* rather than narrows. `withUser` and
        // `withInvitation` each admit the caller's own rows; this one admits
        // every tenant's, because draining one queue for the whole platform
        // has no tenant to be scoped to. What bounds it is that a policy
        // attaches to one table: it unlocks `outbox` and nothing else, for
        // SELECT and UPDATE and nothing else, and the worker re-enters
        // withTenant before it reads anything a seller wrote.
        //
        // src/outbox.ts is exempt on the same terms as products.ts — it writes
        // statements and takes the transaction from its caller — with one
        // difference worth naming: `runOutboxPass` opens a transaction through
        // withOutbox rather than receiving one, because the claim, the send and
        // the release have to be the same transaction for the ordering to mean
        // anything. It is listed separately so that difference stays visible.
        //
        // src/with-widget-key.ts is exempt from P2-07, and it is the fifth RLS
        // context — a design change, recorded in ADR 0022. It narrows rather
        // than widens: a public key and a normalised origin admit one key row,
        // that tenant's matching domain, and the tenant row only behind a
        // verified domain. What makes it safe to hold is that its transaction
        // is READ ONLY, so nothing inside it can write whatever a policy admits.
        // src/widget-resolution.ts is exempt on outbox.ts's terms: it writes one
        // statement and opens its transaction through that scope, never
        // through a raw connection.
        pathNot:
          '^packages/db/src/(client|with-tenant|with-user|with-invitation|with-outbox|with-widget-key|widget-resolution|deploy|auth-db|memberships|members-write|audit|users|invitations)[.]ts$' +
          '|^packages/db/src/outbox[.]ts$' +
          '|^packages/db/src/email-suppressions[.]ts$' +
          // src/rate-limit.ts is exempt from P2-02 on the same terms: it writes a
          // statement and takes the connection from its caller. Its table has no
          // tenant_id by design (P0-34) — the tenant is inside the bucket key,
          // because the limiter also counts callers who belong to no tenant — so
          // there is no scoped read for a missing context to narrow.
          '|^packages/db/src/rate-limit[.]ts$' +
          // src/webhooks.ts is exempt from P0-64b, and unlike the two files
          // above it really does open a connection. A webhook arrives outside
          // any request — no session, no membership row, no tenant to set — and
          // both tables it touches are among the handful with no tenant_id and
          // no policy: `processed_webhooks` because the tenant is derived *from*
          // the event and may not exist, `email_suppressions` because the
          // reputation it protects belongs to the sending domain rather than to
          // one winery. So nothing scoped is read and nothing widens. It is not
          // a fourth GUC: no setting is set and no policy admits one. A handler
          // reaching a tenant table from inside it would be a design change,
          // and would get nothing back.
          '|^packages/db/src/webhooks[.]ts$' +
          // src/products.ts is exempt from P1-02 on the same terms as audit.ts
          // and invitations.ts: it writes statements and takes the connection
          // from its caller, opening nothing. Its tables *are* tenant-scoped
          // and under policy, so unlike the three above there is no second
          // argument to make — the caller is inside withTenant, which is the
          // ordinary case this rule exists to preserve.
          // src/products-upsert.ts is exempt from P1-24 on the same terms: the
          // bulk import writes its statements inside the caller's withTenant
          // transaction and opens nothing, so every SKU it reads is scoped by the
          // policy on `products` like any other product write.
          '|^packages/db/src/products(-read|-upsert)?[.]ts$' +
          // src/import-runs.ts is exempt from P1-26 on the same terms: it claims
          // and completes an import attempt inside the caller's withTenant
          // transaction, and import_runs carries the boilerplate tenant policy.
          '|^packages/db/src/import-runs[.]ts$' +
          // src/token-revocations.ts is exempt from P2-12a on outbox.ts's terms:
          // it writes one statement and opens its transaction through
          // withTenant, never through a raw connection, and token_revocations
          // carries the boilerplate tenant policy.
          '|^packages/db/src/token-revocations[.]ts$' +
          // src/security-events.ts is exempt from P2-16, and unlike most of the
          // statement modules it opens its own transaction: a refusal is a fact
          // about an attempt, so the row must not roll back with the request
          // that caused it. It is not a seventh context and sets no GUC - with a
          // tenant it goes through withTenant, and without one it writes the
          // unattributed row this table's own WITH CHECK admits by name (P0-32).
          '|^packages/db/src/security-events[.]ts$' +
          // src/retrieval.ts is exempt from P2-18 on products.ts's terms: it
          // writes the §4.4 search statements and takes the transaction from
          // its caller, opening nothing. Its tables are tenant-scoped and under
          // policy, and the caller is inside withTenant — which is what makes a
          // whole retrieval one transaction on one connection (P2-20).
          '|^packages/db/src/retrieval[.]ts$' +
          // src/conversations.ts is exempt from P2-30 on products.ts's terms: it
          // writes the turn and reads the history back, and takes the transaction
          // from its caller — which is the row's own requirement rather than a
          // convenience, because the turn and P2-31's usage_events row have to be
          // one write. Both tables carry the boilerplate tenant policy.
          '|^packages/db/src/conversations[.]ts$' +
          // src/usage.ts is exempt from P2-31 on the same terms: it inserts the
          // ledger row and counts the period inside the caller's withTenant
          // transaction, opening nothing. usage_events carries the boilerplate
          // tenant policy, and is append-only at the grant level (P0-31) — so
          // the only statement it can issue is the INSERT it does.
          '|^packages/db/src/usage[.]ts$' +
          // src/with-lapsed-revocations.ts is exempt from P2-14, and it is the
          // sixth RLS context — a design change, recorded in ADR 0023. It widens
          // across tenants like with-outbox.ts, and what bounds it is in the
          // policy rather than the file: the flag admits a revocation only once
          // its token lapsed past the continuation window, and WITH CHECK stays
          // tenant-only. It opens a transaction and sets one GUC, nothing else.
          '|^packages/db/src/with-lapsed-revocations[.]ts$' +
          // src/embeddings.ts is exempt from P1-37 on the same terms as
          // products.ts: it writes statements and takes the transaction from
          // its caller, opening nothing. Its tables are tenant-scoped and under
          // policy, and the caller is inside withTenant — which is the point,
          // because opening that transaction with the tenant named in a queue
          // message is what makes a message for the wrong tenant match no row.
          '|^packages/db/src/embeddings[.]ts$' +
          // src/embedding-status.ts is exempt from P1-39 on the same terms as
          // embeddings.ts, which is where this statement used to live. It moved
          // because three modules need it and `products-read.ts` already
          // imports from `products.ts`, so leaving the write beside either one
          // closed an import cycle — which `no-circular` below caught. It
          // imports `eq` to write one UPDATE and takes the transaction from its
          // caller, opening nothing; `products` is tenant-scoped and under
          // policy, and the caller is inside withTenant.
          '|^packages/db/src/embedding-status[.]ts$' +
          // src/session-cutoffs.ts is exempt from P4-06, and it is two different
          // shapes in one file. `endSessionsFor` takes the caller's transaction
          // and opens nothing — the cutoff and the removal it belongs to have to
          // be one write. `sessionCutoffAt` opens its own, through withTenant
          // and never a raw connection, because it runs on the widget request
          // path where there is no caller transaction to join: exactly the shape
          // `isTokenRevoked` has, for exactly the same reason. Its table carries
          // the boilerplate tenant policy and no second GUC.
          '|^packages/db/src/session-cutoffs[.]ts$' +
          // src/with-secret-key.ts is exempt from P4-10, and it is the seventh
          // RLS context — a design change, recorded in ADR 0026. It opens a
          // READ ONLY transaction, admits one active widget_keys row by the hash
          // of a presented secret, then clears that GUC and sets the tenant from
          // the row, so the rest of the transaction is an ordinary tenant scope.
          '|^packages/db/src/with-secret-key[.]ts$' +
          // src/widget-keys-write.ts is exempt from P4-09 on products.ts's terms:
          // it writes statements and takes the transaction from its caller,
          // opening nothing. `widget_keys` carries the tenant policy with
          // P2-07's widget-key branch, and every statement here runs inside
          // withTenant, so only the tenant half of that policy is ever in play.
          '|^packages/db/src/widget-keys-write[.]ts$' +
          // src/domains-write.ts is exempt from P4-01 on products.ts's terms: it
          // writes statements and takes the transaction from its caller, opening
          // nothing. `tenant_domains` carries the boilerplate tenant policy, and
          // the insert names no tenant at all — it reads the GUC, which is why a
          // caller outside withTenant writes nothing rather than writing wrongly.
          '|^packages/db/src/domains-write[.]ts$' +
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
      /**
       * The browser bundles must not pull in the `core` barrel (P1-13).
       *
       * `packages/core` depends on `@catalogorosso/db` and Better Auth, so one
       * `import { ... } from '@catalogorosso/core'` in a Preact component drags
       * `drizzle-orm`, the whole schema and an auth server into a file a
       * visitor downloads. Nothing fails: the build succeeds, the page works,
       * and the bundle is several hundred kilobytes larger than anybody
       * intended - the same reason `ProductForm` validates against
       * `api-client` rather than against the table contracts.
       *
       * Two subpaths are exempt, and each resolves to a single file that
       * imports nothing at all: `/completeness`, which lets the dashboard and
       * the API score a product with the *same* function rather than with two
       * that disagree, and `/inline-edit` (P1-11), which lets the grid and the
       * hash test agree on which fields a cell may edit. This rule cannot see
       * what a subpath imports, so `packages/core/test/browser-subpaths.test.ts`
       * holds every declared subpath to "imports nothing".
       */
      name: 'no-core-barrel-in-browser-bundles',
      severity: 'error',
      comment:
        'apps/dashboard and apps/widget may import @catalogorosso/core only through a ' +
        'narrow subpath. The package barrel pulls drizzle-orm and Better Auth into a ' +
        'browser bundle, silently.',
      from: {
        path: '^apps/(dashboard|widget)/',
      },
      to: {
        path: '(^|/)node_modules/@catalogorosso/core/(dist/)?index|^@catalogorosso/core$',
      },
    },

    {
      // P1-42. The model adapters carry vendor SDKs and, for Gemini and
      // Anthropic, read API keys. A browser bundle that imported one would ship
      // both to every visitor, and neither is something a bundler warns about.
      name: 'no-llm-in-browser-bundles',
      severity: 'error',
      comment:
        'apps/dashboard and apps/widget must never import @catalogorosso/llm: it carries ' +
        'vendor SDKs and reads provider credentials, and a browser bundle ships both.',
      from: {
        path: '^apps/(dashboard|widget)/',
      },
      to: {
        path: '^packages/llm/|(^|/)node_modules/@catalogorosso/llm($|/)|^@catalogorosso/llm($|/)',
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
      // The eval package (P1-45) is test-time only, like packages/testing: it
      // carries fixture catalogues and, from P1-46, a harness that seeds a
      // database. A production import of either is a bug, and nothing about it
      // would fail a build.
      name: 'no-eval-in-production',
      severity: 'error',
      comment:
        'Production code must not import @catalogorosso/eval. It carries the golden eval ' +
        'dataset and the harness that scores models against it; test files may import it.',
      from: {
        path: '^(apps|packages)/',
        pathNot: '(^|/)test/|^packages/eval/',
      },
      to: {
        path: '^packages/eval/|(^|/)node_modules/@catalogorosso/eval($|/)|^@catalogorosso/eval($|/)',
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
