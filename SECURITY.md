# Security policy

These SDKs sit on both sides of a trust boundary, and which side a package is
on determines what it is allowed to hold. That is the policy, not a style
guide.

## Reporting

Report suspected vulnerabilities through Circle's [Vulnerability Disclosure
Program](https://hackerone.com/circle-bbp). Do not open a public issue.

## Invariants

**`packages/web` — runs in the end user's browser.**

- It **never holds an entity API key** and **never calls `/v1/daa`**. Opening a
  ceremony and submitting its result are server-to-server; the only thing that
  crosses into the browser is an opaque, single-use ceremony token. The
  invariant it exists to keep: _a client that could call `/v1/daa` directly
  would be a credential leak._
- It **never receives the ceremony summary from the distributor's backend.** The
  amount and destination are fetched by the Circle-origin frame from Circle.
  The frame token is never put in the iframe URL, where page scripts and
  Resource Timing could read it: the frame loads bare, asks for the token by
  `postMessage`, and only renders once the origin that sent it matches the
  one DAA resolved for the ceremony.
- The ceremony response is **relayed opaquely** — not reshaped, not
  re-serialized, not inspected. Re-encoding a nested field invalidates the
  signature over it.
- `postMessage` uses an **explicit `targetOrigin`, never `"*"`**, and inbound
  messages are checked on **both `event.origin` and `event.source`**. Origin
  alone accepts a different frame on the Circle origin.
- The ceremony token is a capability: treat it as a secret in transit. It grants
  a read of exactly one pending ceremony and expires in minutes.

**`packages/node` — runs on the distributor's server.**

- The only package permitted to hold an entity API key.
- Must not be a dependency of, imported by, or bundled into any client-side
  package.

## Supply chain

Every dependency resolves from public npm, and the workspace has no private
registry configuration. A contributor or CI runner without special registry
credentials can build and test the repo — which also means the dependency set is
auditable by anyone reviewing a published package.
