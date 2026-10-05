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
