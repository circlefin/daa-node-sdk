/**
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
