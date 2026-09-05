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
          // Root-level tooling configs live in no tsconfig by design.
          allowDefaultProject: ['*.config.ts', '*.config.mts', '*.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Root config files are not in any tsconfig — disable type-aware rules
  {
    files: ['*.config.{js,ts,mjs,mts}'],
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
      globals: { console: 'readonly', process: 'readonly' },
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
