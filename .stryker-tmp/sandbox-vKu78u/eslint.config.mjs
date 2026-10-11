// @ts-nocheck
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // extension/lib holds tsc-emitted js + the vendored hub bundle; space is
    // a separate app with its own toolchain
    ignores: [
      '.stryker-tmp/**',
      'tests/fixtures/**',
      'dist/**',
      'dist-base/**',
      'builder/dist/**',
      'coverage/**',
      'extension/lib/**',
      'extension/*.js',
      'space/**',
      'node_modules/**',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      complexity: ['error', 8],
      'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['tests/**/*.ts', 'tests/helpers/**/*.ts'],
    rules: {
      'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
      // fixtures are known-shaped: non-null reads on them are assertions of
      // the fixture contract, not logic
      '@typescript-eslint/no-non-null-assertion': 'off',
      // test fakes return canned values synchronously inside async shapes,
      // and listeners are awaited for ordering that the tick() provides
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      'no-empty-function': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
);
