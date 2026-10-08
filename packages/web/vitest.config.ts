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

import { defineConfig } from 'vitest/config'

// No DOM environment. Every browser API this package touches is reached
// through an injected seam, so the suite runs on plain Node — see README.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // `lcov` is required and is NOT a vitest default (the defaults are
      // text/html/clover/json). SonarQube reads `coverage/lcov.info`, and the
      // Circle's CI coverage merge step merges per-package `lcov.info`
      // files — with no lcov reporter there is nothing for either to read and
      // coverage silently reports as 0%.
      //
      // Setting `reporter` replaces the defaults rather than adding to them,
      // so `html` is gone from this list — but the HTML report is not: the
      // `lcov` reporter emits its own at **coverage/lcov-report/index.html**.
      // Adding `html` back would produce a second, complete HTML tree at
      // coverage/index.html for the same data, so the path moved rather than
      // the report disappearing.
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
})
