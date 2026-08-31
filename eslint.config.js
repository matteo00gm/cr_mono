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
