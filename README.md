# DAA JavaScript SDKs

Client and server SDKs for Digital Asset Accounts, as a pnpm + turbo workspace.
Each package is versioned, tagged and released independently.

## Layout

```
packages/
  web/          @circle-fin/daa-web-sdk     browser — SCA passkey ceremonies
  node/         @circle-fin/daa-node-sdk     server  — API-key authenticated endpoints
```

> **On the repo name.** `daa-node-sdk` predates this layout and now holds a
> browser package as well as the server one. Renaming it
> was considered and **deliberately declined** — the published names
> (`@circle-fin/daa-web-sdk` and `@circle-fin/daa-node-sdk`) are the contract a distributor sees, and the
> repo name is not part of it. Read the directory, not the repo, to know which
> side of the trust boundary you are on.

The split is by **trust boundary**, not by language — that is the one thing to
understand before adding code here.

|                         | `node`                      | `web`                  |
| ----------------------- | --------------------------- | ---------------------- |
| Runs on                 | the distributor's server    | the end user's browser |
| Holds an entity API key | **yes** — that is the point | **never**              |
| Calls Circle APIs       | directly                    | never                  |
| Module format           | ESM only                    | ESM only               |

The split is a security boundary, not a directory convention. The Node package
is the only one that receives the entity API key; the browser package receives
only the ceremony token needed to run the Circle-hosted flow. Keeping them as
separate packages prevents the server credential and server-only code from
entering a browser bundle.

## No private registry

Everything **resolves** from public npm. There is no `.npmrc` and no
`@circlefin/*` preset dependency, deliberately: these packages are installed by
distributors, so a fresh clone, an external runner, or a contributor without
special registry credentials must still be able to build and test.

**Publishing** is confined to CI automation; nothing here can publish from a
local checkout.

## Development

```bash
pnpm install
pnpm lint          # eslint, no --fix
pnpm check:type
pnpm test
pnpm test:coverage # what CI runs
pnpm build
pnpm format:check
```

## Releases

release-please v4 in **manifest mode** manages versioning for this workspace.

A merge to `master` opens a release PR **per package**, derived from
Conventional Commit titles and routed by path: `feat(web): …` touching
`packages/web` bumps only `@circle-fin/daa-web-sdk`. Each package gets its own
tag (`daa-web-sdk-v0.2.0`) and its own release notes. The `node-workspace`
plugin patch-bumps dependents when a shared package changes and rewrites
`workspace:*` to a real range at publish time.

Packages are `private: true` in the repo and stay that way. The publish
workflow flips it in the manifest it packs, so a checkout — or a stray
`pnpm publish` — cannot publish anything.

Public releases are published to npm under `@circle-fin`.
