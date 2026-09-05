// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-e2e/**', '**/playwright-report/**', '**/test-results/**', '**/coverage/**', '**/node_modules/**', 'supabase/functions/**', '**/*.config.*', '**/scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: { ...reactHooks.configs.recommended.rules, 'react-refresh/only-export-components': ['warn', { allowConstantExport: true }] },
  },
  {
    // UI primitives export variants/hooks alongside components by design (shadcn convention); providers export hooks.
    files: ['apps/web/src/components/ui/**/*.tsx', 'apps/web/src/features/**/*-provider.tsx', 'apps/web/src/routes.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    // TanStack Table v8 is flagged by the React Compiler heuristics; it is used in a plain hook without compiler assumptions.
    files: ['apps/web/src/components/data-table/**/*.tsx'],
    rules: { 'react-hooks/incompatible-library': 'off' },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}', 'apps/worker/**/*.ts', 'apps/api/src/index.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
