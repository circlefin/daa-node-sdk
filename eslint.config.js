// Flat config (ESLint 9), shared by every package in the workspace.
//
// Formatting is Prettier's job, so eslint-config-prettier turns off the
// stylistic rules that would fight it.
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // Config files are not source and are not in a TS project. A mistake in
      // one fails at load time, which is a stronger check than linting it.
      '**/eslint.config.js',
      '**/*.config.mjs',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // A ceremony surface is fed arbitrary cross-origin data, so readers take
      // `unknown` and narrow explicitly. `no-explicit-any` stays on to keep
      // that honest.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Build scripts are plain ESM with no TS project behind them. Type-aware
    // rules cannot run, but the rest can — these have real logic and are worth
    // linting, unlike the config files above which are ignored outright.
    files: ['**/scripts/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // Test doubles legitimately hand in shapes the production types reject.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  prettier,
)
