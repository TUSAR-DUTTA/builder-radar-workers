import { defineConfig, globalIgnores } from 'eslint/config';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextTs,
  globalIgnores([
    'node_modules/**',
    'src/db/**',
    'src/lib/**',
    'src/types/**',
    'test/**',
    'playwright_google_profile/**',
    'playwright_sessions/**',
  ]),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
    },
  },
]);
