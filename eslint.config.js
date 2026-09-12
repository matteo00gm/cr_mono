import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/.sst/**',
      '**/sst-env.d.ts',
      '**/coverage/**',
      // Claude Code's scratch worktrees: checkouts of this same repository,
      // created under `.claude/worktrees/` when an agent needs an isolated
      // tree. `.git/info/exclude` keeps them out of git, but that file is local
      // and ESLint does not read it — so without this, `pnpm lint` reports
      // errors in somebody else's checkout of the same code.
      '.claude/**',
      // SST owns these. They depend on globals ($config, $app, sst.aws.*)
      // typed by .sst/platform/config.d.ts, which `sst install` generates and
      // git ignores — so they belong to no tsconfig and type-aware rules have
      // no program to resolve against. `sst diff` is what checks them.
      'sst.config.ts',
      'infra/**',
    ],
  },

  // Base recommended rules for all TS files
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // TypeScript parser options
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          /*
           * Root-level tooling configs live in no tsconfig by design — and so
           * does `apps/dashboard/vite.config.ts`, for the same reason: it
           * configures the bundler rather than being bundled, and putting it in
           * the app's `include` would make the app's own typecheck depend on
           * Vite's types.
           */
          allowDefaultProject: [
            '*.config.ts',
            '*.config.mts',
            '*.config.js',
            'apps/dashboard/vite.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  /*
   * Tooling configs are in no tsconfig — disable type-aware rules.
   *
   * A recursive glob rather than a root-only one: without the leading
   * double-star the pattern matches only the repository root, and
   * `apps/dashboard/vite.config.ts` fell through to the default project —
   * where four rules report "requires strictNullChecks" and one reports an
   * unresolved call, none of which is about the file. A config that configures
   * the bundler is not part of the app it bundles, and putting it in the app's
   * `include` would make the app's own typecheck depend on Vite's types.
   */
  {
    files: ['**/*.config.{js,ts,mjs,mts}'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Build/CI scripts: plain ESM JavaScript, deliberately outside every
  // tsconfig. Type-aware rules need a program these files do not belong to,
  // so the project service is switched off for them rather than being fed a
  // synthetic default project.
  {
    files: ['scripts/**/*.{js,mjs}', '*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false },
      /*
       * Node's own globals, listed rather than pulled from the `globals`
       * package for one dependency's worth of convenience. Everything here is
       * provided by the Node 22 runtime these scripts run on; `Response` is
       * needed because `gen-openapi.mjs` builds a stub fetch handler.
       */
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
      },
    },
  },

  // Repo-specific rules: dependency direction enforcement
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@catalogorosso/api',
                '@catalogorosso/worker',
                '@catalogorosso/dashboard',
                '@catalogorosso/widget',
              ],
              message:
                'Packages may not import from apps — dependency flows from packages → apps only.',
            },
          ],
        },
      ],
    },
  },

  /*
   * The highest-value IDOR prevention in the codebase (P0-48).
   *
   * A tenant id read from a request is attacker-controlled; the only
   * trustworthy source is a `memberships` row for the authenticated user
   * (§3.5). That invariant degrades quietly — one handler reading a tenant id
   * from the request for convenience reopens it, and the handler's own tests
   * all still pass because they send the "right" value.
   *
   * The rule and P0-48's behavioural test are both necessary and neither is
   * sufficient: the test catches behaviour that is already wrong, the rule
   * catches the next author before they write it.
   *
   * The plan names Express accessors (`req.body`, `req.query`, ...). This app is
   * Hono, so the selectors below target `c.req.query()`, `c.req.param()`,
   * `c.req.header()` and `c.req.valid()` instead — a rule written against the
   * wrong framework's API would have matched nothing and looked like protection.
   */
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // `c.req.header('x-tenant-id')`, `c.req.query('tenantId')`, and so on.
          selector:
            'CallExpression[callee.property.name=/^(query|queries|param|header)$/] > Literal[value=/tenant/i]',
          message:
            'Tenant identity must never come from a request (§3.5). Read it from ' +
            "c.get('tenantId'), which P0-47's middleware resolves from a memberships row.",
        },
        {
          /*
           * The same call with a *named constant* argument, which is how the
           * one legitimate read is written. Without this the rule would be
           * trivially sidestepped by hoisting the string into a const — and the
           * file-level exception below would be decorative rather than real.
           */
          selector:
            'CallExpression[callee.property.name=/^(query|queries|param|header)$/] > Identifier[name=/tenant/i]',
          message:
            'Tenant identity must never come from a request (§3.5). Only ' +
            'apps/api/src/middleware/tenant.ts may read the active-tenant selection, ' +
            'and it re-validates it against the caller memberships on every request.',
        },
        {
          /*
           * Raw `fetch` to our own API, outside the client (P0-63).
           *
           * Not about ergonomics. `docs/api/consumers.md` is derived from the
           * calls themselves, so it is complete only while every call goes
           * through `@catalogorosso/api-client` naming its endpoint as a
           * literal. One raw `fetch('/v1/…')` makes that map a subset, and
           * nothing says which subset — worse than not having it, because it
           * is still trusted.
           *
           * Matched on the *argument*: a call to a seller's site or to Bedrock
           * is fine and common. What is forbidden is reaching our own API
           * around the one place that records that it happened.
           *
           * The backslashes are doubled because this is a JS string — `"\/"`
           * collapses to `/`, and the selector would carry `//v1//`, a regex
           * matching nothing and a rule silently never firing.
           */
          selector: "CallExpression[callee.name='fetch'] > Literal[value=/\\/v1\\//]",
          message:
            'Use @catalogorosso/api-client instead of calling our own API directly (P0-63). ' +
            'The consumer map is derived from client calls, and a raw fetch makes it ' +
            'silently incomplete.',
        },
        {
          selector:
            "CallExpression[callee.name='fetch'] > TemplateLiteral > TemplateElement[value.raw=/\\/v1\\//]",
          message: 'Use @catalogorosso/api-client instead of calling our own API directly (P0-63).',
        },
        {
          /*
           * `c.req.valid('json').tenantId`, `c.req.query().tenantId`,
           * `(await c.req.json()).tenantId`, and `body.tenantId`.
           *
           * Scoped to request-shaped objects rather than to the property name
           * alone. A bare `MemberExpression[property.name='tenantId']` also
           * flags `membership.tenantId` and `context.tenantId` — the *resolved*
           * value, which is precisely what handlers are supposed to use — so
           * the broad version would train people to disable the rule.
           */
          selector:
            "MemberExpression[property.name='tenantId'][object.callee.property.name=/^(json|valid|parseBody|query|queries|param)$/]," +
            "MemberExpression[property.name='tenantId'][object.type='AwaitExpression']," +
            "MemberExpression[property.name='tenantId'][object.name=/^(body|payload|input|params|query|headers|req|request)$/]",
          message:
            'Tenant identity must never be read off a request payload (§3.5). Use ' +
            "c.get('tenantId'), which comes from a memberships row.",
        },
      ],
    },
  },

  /*
   * The one sanctioned exception, named as a file rather than as a pattern.
   *
   * `resolveTenant` reads the active-tenant header because a user may belong to
   * several wineries and something has to choose between them. What it reads is
   * a *selection among rows the database already agrees exist*, re-validated on
   * every request — not an assertion of identity. A second file appearing here
   * should be treated as a design change, not a config tweak.
   */
  {
    files: ['apps/api/src/middleware/tenant.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  /*
   * The same `fetch` prohibition for the packages and apps that carry no tenant
   * rule of their own.
   *
   * Separate because ESLint flat config *replaces* a rule when a later object
   * configures it again rather than merging — so `apps/api` must carry both
   * sets in one array (above), and everything else carries only this one.
   * Getting that wrong silently disabled P0-48's IDOR rule, and its self-test
   * is what caught it.
   */
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    ignores: ['apps/api/**', 'packages/api-client/**', '**/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          /*
           * Raw `fetch` to our own API, outside the client (P0-63).
           *
           * Not about ergonomics. `docs/api/consumers.md` is derived from the
           * calls themselves, so it is complete only while every call goes
           * through `@catalogorosso/api-client` naming its endpoint as a
           * literal. One raw `fetch('/v1/…')` makes that map a subset, and
           * nothing says which subset — worse than not having it, because it
           * is still trusted.
           *
           * Matched on the *argument*: a call to a seller's site or to Bedrock
           * is fine and common. What is forbidden is reaching our own API
           * around the one place that records that it happened.
           *
           * The backslashes are doubled because this is a JS string — `"\/"`
           * collapses to `/`, and the selector would carry `//v1//`, a regex
           * matching nothing and a rule silently never firing.
           */
          selector: "CallExpression[callee.name='fetch'] > Literal[value=/\\/v1\\//]",
          message:
            'Use @catalogorosso/api-client instead of calling our own API directly (P0-63). ' +
            'The consumer map is derived from client calls, and a raw fetch makes it ' +
            'silently incomplete.',
        },
        {
          selector:
            "CallExpression[callee.name='fetch'] > TemplateLiteral > TemplateElement[value.raw=/\\/v1\\//]",
          message: 'Use @catalogorosso/api-client instead of calling our own API directly (P0-63).',
        },
      ],
    },
  },

  // Widget-specific: ban innerHTML and dangerouslySetInnerHTML
  {
    files: ['apps/widget/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message: 'innerHTML is banned in the widget. Use text nodes only (§3.7).',
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned in the widget. Use text nodes only (§3.7).',
        },
      ],
    },
  },

  // Prettier must be last — disables ESLint rules that conflict with formatting
  eslintConfigPrettier,
);
