import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/.sst/**', '**/coverage/**'],
  },

  // Base recommended rules for all TS files
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // TypeScript parser options
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Root config files are not in any tsconfig — disable type-aware rules
  {
    files: ['*.config.{js,ts,mjs,mts}'],
    ...tseslint.configs.disableTypeChecked,
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
