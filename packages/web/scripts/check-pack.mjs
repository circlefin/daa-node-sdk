#!/usr/bin/env node
// Asserts the published tarball contains what `exports` promises, and that its
// manifest is one a consumer outside this workspace can actually install.
//
// `files` in package.json is an allowlist, so adding a file to the repo does
// not add it to the tarball — and an `exports` entry pointing at a path that
// was never packed produces a package that installs cleanly and then fails at
// import time with a bare ERR_MODULE_NOT_FOUND. This derives the list from
// `exports` rather than hardcoding filenames, so a new subpath is covered
// without anyone remembering to extend the check.
//
// ## `pnpm pack`, not `npm pack`
//
// The two do not produce the same tarball in a pnpm workspace, so packing with
// the one nobody publishes would validate the wrong artifact. Two differences,
// both measured against packages/web at 0.1.0:
//
//   catalog:   `npm pack` leaves the workspace-only `catalog:` protocol
//              verbatim in the packed manifest — `"vitest": "catalog:"`.
//              `pnpm pack` resolves it to the range in pnpm-workspace.yaml —
//              `"vitest": "4.1.1"`. Harmless to an install today only because
//              every `catalog:` entry here is a devDependency; the first
//              runtime dependency taken from the catalog would break every
//              consumer install, and `catalog:` in a published manifest
//              already breaks anything that reads one.
//   LICENSE    `npm pack` ships none. There is no LICENSE under packages/*,
//              and npm's implicit include only looks inside the package
//              directory. `pnpm pack` copies the workspace-root LICENSE in.
//              The npm tarball therefore declares `"license": "Apache-2.0"`
//              and carries no license text at all.
//
// The release workflows pack with pnpm for the same reason, and re-assert
// the specifier check below against the tarball they are about to publish —
// so that guarantee does not depend on every package's `check:pack` being
// current.
//
// Reads the tarball from disk rather than `--json`: `prepack` runs the build,
// whose output lands on stdout and corrupts the JSON. That motivates not
// *parsing* stdout — not suppressing it. tsc writes its diagnostics to stdout,
// so discarding it turns any build failure inside `prepack` into a bare
// "Command failed: pnpm pack" with no compiler errors anywhere.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

// Lexicographic by UTF-16 code unit. `Array.prototype.sort` with no comparator
// sorts by string coercion, which is what is wanted here but is not what the
// call *says* (SonarQube S2871) — and stops being true the moment the array
// holds anything that is not already a string.
const byCodeUnit = (a, b) => {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/** Every relative path `exports`, `main` and `types` promise a consumer. */
const promised = new Set()
const collect = (node) => {
  if (typeof node === 'string') {
    if (node.startsWith('./') && !node.endsWith('package.json')) {
      promised.add(node.slice(2))
    }
    return
  }
  if (node && typeof node === 'object') Object.values(node).forEach(collect)
}
collect(pkg.exports)
collect(pkg.main)
collect(pkg.types)
promised.add('README.md')
// `license` in package.json is a claim; LICENSE is the text that makes it one.
// This passes only because `pnpm pack` copies the workspace-root file in, so
// asserting it is what stops a switch back to `npm pack` from shipping an
// Apache-2.0 declaration with nothing behind it.
promised.add('LICENSE')

const tgzs = () => readdirSync('.').filter((f) => f.endsWith('.tgz'))
tgzs().forEach((f) => rmSync(f))

execFileSync('pnpm', ['pack'], { stdio: ['ignore', 'inherit', 'inherit'] })

const tarball = tgzs()
  .map((f) => ({ f, t: statSync(f).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0]?.f
if (tarball === undefined) {
  console.error('check:pack: pnpm pack produced no tarball')
  process.exit(1)
}

const packed = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.replace(/^package\//, '').trim())
  .filter(Boolean)
const packedManifest = JSON.parse(
  execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
)
rmSync(tarball)

const problems = []

for (const path of [...promised].sort(byCodeUnit)) {
  if (!packed.includes(path)) {
    problems.push(`missing: ${path} — the package promises it, the tarball does not contain it`)
  }
}

// Tests must never ship. They are the largest thing under `src`, they are not
// part of the contract, and shipping them invites a consumer to import the
// in-memory double from a path that is not the `./testing` subpath.
for (const path of packed) {
  if (/\.test\.[cm]?tsx?$/.test(path) || path.split('/').includes('__tests__')) {
    problems.push(`should not ship: ${path}`)
  }
}

// Every dependency specifier must be a range a consumer can resolve from the
// registry. Three ways that fails, kept separate because the reasons differ
// and the message should say which one applies:
//
//   catalog:/workspace:  resolve only inside this workspace. pnpm rewrites
//                        both while packing, so a hit means the tarball came
//                        from something that does not — the regression this
//                        exists to catch.
//   file:/link:          name a path that does not exist on a consumer's disk.
//   git+/github:/url     resolve, but not from the registry: unpinned, and
//                        outside the registry's scanning and cooldown policies.
//
// This set is deliberately the same one the release workflow asserts on the
// tarball it is about to publish. It was narrower here, which
// made the comment above claiming the workflow "re-asserts" it false: a `git+`
// dependency passed the gate every PR runs and would only have failed at
// publish time. Widen both together or neither.
const REJECTED = [
  { re: /^(catalog:|workspace:)/, why: 'resolves only inside this workspace' },
  { re: /^(file:|link:)/, why: 'names a path that will not exist on a consumer machine' },
  {
    re: /^(git\+|github:|https?:\/\/|ssh:)/,
    why: 'does not come from the registry, so it is unpinned and unscanned',
  },
]
for (const block of [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]) {
  const entries = Object.entries(packedManifest[block] ?? {}).sort(([a], [b]) => byCodeUnit(a, b))
  for (const [name, spec] of entries) {
    if (typeof spec !== 'string') continue
    const rejected = REJECTED.find(({ re }) => re.test(spec))
    if (rejected !== undefined) {
      problems.push(`bad specifier: ${block}.${name} is "${spec}" — ${rejected.why}`)
    }
  }
}

// Read off the *packed* manifest, not `pkg`. Presence, not a particular range:
// the range is the manifest's call, and pinning a literal here would mean two
// places to edit to bump it. This package runs in a browser, so its
// `engines.node` describes the toolchain that installs and bundles it rather
// than a runtime — declared anyway, because a consumer resolving one floor for
// one half of the SDK and none for the other is the surprise.
//
// The release workflow asserts the same thing on the tarball it publishes,
// where the manifest has been rebuilt by jq and this check has already run
// against a different file.
if (typeof packedManifest.engines?.node !== 'string' || packedManifest.engines.node === '') {
  problems.push(
    'engines.node: not declared in the packed manifest, so a consumer gets no Node floor',
  )
}

if (problems.length > 0) {
  console.error(`check:pack: ${problems.length} problem(s) in ${pkg.name}\n`)
  problems.forEach((p) => console.error(`  ${p}`))
  console.error('\nPacked contents:')
  packed.forEach((p) => console.error(`  ${p}`))
  console.error('\nFix the `files` allowlist or the `exports` map in package.json.')
  process.exit(1)
}

console.log(
  `check:pack: ${pkg.name} packs ${packed.length} files; all ${promised.size} promised paths present, no tests shipped, no workspace-only specifiers, engines.node ${packedManifest.engines.node}`,
)
