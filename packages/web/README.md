# `@circle-fin/daa-web-sdk`

Browser SDK for Digital Asset Accounts Strong Customer Authentication.

Circle is the WebAuthn relying party. This SDK runs on the **distributor's
origin** and mounts a **Circle-origin** ceremony document; the passkey ceremony
happens inside that document, and the server verifies the returned response.

## Three invariants this package exists to keep

1. **It never holds DAA entity credentials.** Opening a ceremony and submitting
   its result are server-to-server. A browser that could call `/v1/daa`
   directly would be a credential leak.
2. **It never receives the summary from the distributor's backend.** The Circle
   frame fetches the amount and destination from Circle itself, using a token
   that never appears in the iframe URL; see [Protecting the ceremony token](#protecting-the-ceremony-token).
3. **The ceremony response is relayed opaquely** — not reshaped, not
   re-serialized, not inspected.

## Usage

```ts
import { createScaClient, isScaError } from '@circle-fin/daa-web-sdk'

const sca = createScaClient({ environment: 'production' })

// The distributor's BACKEND calls POST /v1/accounts/passkeys/registrations
// and passes only the frameToken to the page.
try {
  const attestationResponse = await sca.enroll(frameToken, {
    mode: 'inline',
    container: document.getElementById('sca')!,
  })

  // Send it to your own backend, which completes registration against
  // POST /v1/accounts/passkeys. Pass it through unchanged.
  await fetch('/api/passkeys/complete', {
    method: 'POST',
    body: JSON.stringify({ registrationId, attestationResponse }),
  })
} catch (error) {
  if (isScaError(error) && error.code === 'Cancelled') {
    // Not an error state — offer a retry.
  }
}
```

The distributor writes no `allow` attribute and no `postMessage` handling. Both
are the SDK's, because a mistake in either fails WebAuthn with an error that
names nothing.

## Where the ceremony appears

Two presentations, and the choice is only about layout — the frame, the
protocol and the trust boundary are identical in both.

```ts
// The distributor lays it out. The SDK sizes the frame and nothing else.
await sca.enroll(frameToken, { mode: 'inline', container })

// The SDK draws the dialog: backdrop, panel, close button, focus trap,
// scroll lock. Nothing to lay out and nothing to style.
await sca.approve(frameToken, { mode: 'modal' })
```

`modal` exists so that a distributor does not rebuild a dialog per
integration, and so a passkey ceremony looks the same wherever it appears: a
centered panel at `32rem`, full width less a gutter on narrow screens, over a
dimmed backdrop.

It adds **no dependency and no stylesheet to import**. The rules are plain
CSS in a single `<style>` the SDK injects on first use, because this runs on
your page and cannot assume a framework, a build step or a theme. Nothing
needs to be imported, bundled or loaded in a particular order.

Only the chrome is drawn here. Everything inside the panel — the heading, the
amount and destination, the buttons, "Secured by Circle" — is the
Circle-origin document, which is the whole point: the SDK cannot render the
copy the user approves, so it doesn't.

| Option        | Default                 | What it is                                                                                                                                                                        |
| ------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | `Circle security check` | The dialog's **accessible name**, not its heading. The heading is inside the frame and this side of the boundary is never told which ceremony is running.                         |
| `dismissible` | `true`                  | Whether the X, `Escape` and a backdrop click close it. Dismissal rejects `Cancelled` unless the frame has already reported an error; the first frame error remains authoritative. |

Two things are worth knowing before choosing `dismissible`:

- **The frame cannot tell the SDK it is busy.** While the browser's or a
  password manager's passkey sheet is open, the frame has no way to say so
  over the protocol, so the X stays live. A dismissal there cancels the
  ceremony and rejects `Cancelled` unless the frame has already reported an
  error; in that case, its first error remains authoritative. The token is
  spent and the caller opens a fresh one. `dismissible: false` is the stricter
  choice, and it does not trap the user — the frame keeps its own Cancel button
  either way.
- **Styling hooks are single-class on purpose.** `.circle-sca-modal`,
  `-overlay`, `-panel`, `-close`, and the `circle-sca-frame` class on the
  iframe itself. The stylesheet is injected at the _start_ of `<head>`, so a
  rule of yours at equal specificity wins by coming later.
- **The dialog sits at `z-index: 60`.** High enough to clear ordinary page
  content, deliberately not `9999`. If you run a chat widget, a cookie banner
  or a notification bar of your own up in the four figures, it will paint over
  the ceremony — raise `.circle-sca-modal`'s `z-index` in your own stylesheet,
  or lower theirs.

The `AbortSignal` in `ScaCeremonyOptions` works in both modes. Abort and modal
dismissal reject `Cancelled` unless the frame has already reported an error; in
that case, the first frame error remains authoritative. Abort is local to the
SDK; it is not a server-side transaction status. A result already posted by
the frame can race with abort, so check your backend's authoritative state
before retrying a stateful action.

They also write no ceremony host. `environment` is one of
`DAA_ENVIRONMENTS` — `smokebox`, `sandbox`, `staging`, `production` — and the
SDK owns which origin each one serves. Same field and same list as
the other DAA SDKs, so an integration that uses more than one configures them
the same way.

The default `ceremonyPath` is `/ceremony`. Set it only if Circle provides a
different ceremony route; it changes the path on the selected origin, not the
origin itself.

That is not tidiness. The ceremony origin is what every inbound `message` is
checked against, an integrator has no way to verify it, and a wrong value does
not error — it drops every message from the real frame, and the ceremony dies
at the ready timeout with a `Transport` that names nothing. There is a
`circleOrigin` override for local development and Circle-internal testing; an
integration should leave it unset. In production, the SDK rejects any origin
other than the canonical one for the selected environment.

### On Safari and iOS, ceremonies open a window

WebKit (Safari on macOS, and **every** browser on iOS and iPadOS) cannot run
either ceremony in a cross-origin iframe:

- **Registration** is refused: it fails with the same `NotAllowedError` a user
  cancel produces, even with the permission delegated.
- **Step-up** completes, but WebKit leaves `topOrigin` out of the signed
  client data. DAA requires it for any ceremony in a cross-origin frame — it
  is the browser's proof of which page embedded the Circle document — so it
  rejects the assertion, and your backend gets
  `The step-up authentication could not be verified`.

So on WebKit, `enroll` and `approve` both run the ceremony in a top-level
window on the Circle origin instead, and `presentation` draws nothing: no
modal, and the inline container is left untouched. Other browsers keep the
frame.

Two things follow for the integration, and both are harmless on the browsers
that keep the frame:

- **Call `enroll` and `approve` synchronously from the click handler, and pass
  the token as a promise.** A window can only be opened during the user's click, and a
  `fetch` for the token spends it. The SDK opens the window blank straight
  away and loads the ceremony once the promise resolves:

  ```ts
  button.addEventListener('click', () => {
    const frameToken = fetch('/api/passkeys/start', { method: 'POST' })
      .then((res) => res.json())
      .then((body: { frameToken: string }) => body.frameToken)

    sca.enroll(frameToken, { mode: 'modal' }).then(complete, handleError)
  })
  ```

  `approve` is the same, with the token from
  `POST /v1/accounts/passkeys/challenges`. Called after an `await` instead,
  the browser blocks the window and the call rejects `Unsupported`. A rejected token promise is
  rethrown unchanged, so your own backend errors reach you as they are.

- **Do not send `Cross-Origin-Opener-Policy: same-origin`** on the page that
  calls `enroll` or `approve`. It severs the window from its opener, so the
  ceremony cannot ask for its token and never starts: the window shows an
  error and the call rejects `Transport` once the ready timeout passes.
  `same-origin-allow-popups` is fine.

Closing the window rejects `Cancelled`, the same as dismissing the modal.

## Entry points

`exports` in `package.json` is the boundary. Anything not listed there —
everything under `src/internal/` — is unreachable on an exports-aware
resolver.

| Subpath      | For                                                                                                                                                      | Contract?                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `.`          | **Distributors.** `createScaClient`, `ScaError`, `isScaError`, and the types those need.                                                                 | **Yes.** Breaking it is a breaking release.  |
| `./protocol` | **Circle's ceremony app.** The `postMessage` envelope: the five builders the frame produces, the reader this SDK uses, and the `ack` in both directions. | No. Internal to Circle.                      |
| `./testing`  | **Tests.** A `FrameHost` fake with a virtual clock, and `createScaClientForTesting`, which is the only entry that accepts a host.                        | No. Testing-only, unsupported in production. |

The last two are published only because their consumers live in other
repositories — the ceremony app, and tests wherever they
are written. They are not part of the distributor-facing API, and changing
them is not a breaking release.

That is a statement about what is _supported_, not about what is _possible_:
both subpaths are ordinary published paths, and nothing stops anyone importing
them. Nothing could — whoever controls the page's JavaScript can replace this
SDK entirely. The boundary that holds is the Circle-origin iframe and the
server-side checks behind it.

A distributor needs none of the envelope. Reading or writing those messages is
this SDK's job on their behalf, and a distributor handling `message` events
itself would be reimplementing the origin and source checks the trust boundary
depends on.

## Error taxonomy

Identical across the web, Android, iOS and React Native SDKs, so a
distributor's error handling is not per-platform.

| Code              | Meaning                                                 | Client action                                                                           |
| ----------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Cancelled`       | User dismissed or declined, or the caller aborted       | The SDK did not deliver a result; check backend state before retrying a stateful action |
| `Expired`         | Ceremony consumed or past its life                      | Open a fresh ceremony, retry once                                                       |
| `Unsupported`     | No user-verifying authenticator, or surface unavailable | Fall back                                                                               |
| `NotEnrolled`     | No active credential for this client entity             | Route to enrollment                                                                     |
| `AlreadyEnrolled` | This end user already holds a credential                | Route to step-up, not enrollment                                                        |
| `Transport`       | Network, Circle unreachable, or no `ready` signal       | Token state may be unknown; request a fresh ceremony before retrying                    |
| `Protocol`        | Frame spoke an envelope this SDK does not understand    | Deployment skew; retrying will not help                                                 |

`Cancelled` and `Unsupported` stay distinguishable on purpose — several
platforms collapse both into a generic "not allowed", and disambiguating is the
SDK's job.

## Protecting the ceremony token

The frame token is a bearer capability for one pending ceremony, so it is kept
out of the iframe's `src`. A URL there is a DOM attribute any script on the
page can read — analytics and session replay tools capture them by default —
and the browser's Resource Timing entry keeps it for the life of the page, even
after the iframe is removed.

Instead the frame loads a tokenless URL and posts `token-request`. The SDK
answers once, into that frame's own window, targeted at the Circle origin. The
frame accepts the first token from its host window only, reads the ceremony,
and refuses to render it unless the origin that delivered the token is the one
DAA resolved for the ceremony.

The token still passes through your page's JavaScript on its way to the SDK.
Do not record or forward it.

## Why there is no jsdom

Every browser capability is reached through the injected `FrameHost` seam
([`src/internal/frameHost.ts`](src/internal/frameHost.ts)), so the ceremony
state machine is unit-tested on plain Node with a virtual clock.

`@circle-fin/daa-web-sdk/testing` ships that double, plus
`createScaClientForTesting(config, host)`. `createScaClient` takes no host on
purpose: a substituted one skips the DOM host's `container instanceof
HTMLElement` check and the `isSource` identity comparison that stops a
different frame on the Circle origin from answering, and both are
load-bearing.

**This is a supported-API boundary, not a security boundary.** `./testing` is
a published subpath, so nothing stops a distributor importing
`createScaClientForTesting` in production — and nothing could, since whoever
controls the page's JavaScript can replace this SDK entirely. What the split
buys is that injecting a host is an unmistakable, unsupported act rather than
an option on the function every integrator already calls. Treat `./testing`
as testing-only and unsupported in production. The boundary that actually
holds is the Circle-origin iframe and the server-side checks behind it.

The consequence is visible in coverage: every module is 96–100% except
`createDomFrameHost`, whose production paths cannot execute without a browser.
Its refusal to build off a browser _is_ covered — that branch is reachable on
plain Node, which is the environment it exists to reject, and it is the first
thing a server-side render hits. What is left uncovered is the DOM work
itself, and that is the trade the seam buys rather than an untested branch of
the state machine.

The gap that remains is real and is tracked separately: nothing yet asserts
that `createDomFrameHost` obeys the same contract as the fake, which is what
makes the fake worth trusting. That needs a real browser and two origins — so
it can exercise `targetOrigin`, `event.origin` and `event.source` rather than
just DOM attributes — and is a prerequisite for the first external release.

## Ordering that is load-bearing

Recorded here because each of these is a real failure, not a style preference,
and each has a test that fails without it.

- **The message listener is attached before the frame is mounted.** A cached
  passkey can resolve before a listener attached after `mount()` would exist.
- **Both `event.origin` and `event.source` are checked.** `origin` alone accepts
  a _different_ frame on the Circle origin, including one an attacker put on the
  page.
- **`targetOrigin` is never `"*"`.** Every `post()` this SDK makes targets
  `config.circleOrigin` explicitly. `"*"` would broadcast the message to every
  ancestor, and the frame may be embedded by a page that is itself embedded.

  Note which hop this is. **Host → frame** (the `token` and the `ack`, what
  this SDK sends) is
  targeted at `circleOrigin` — the value the **distributor** passes to
  `createScaClient()`, which `resolveConfig` checks only for being a bare
  `https:` origin (or `http://localhost`), _not_ against any server-resolved
  allowlist. **Frame → host** is the other direction: there the ceremony app
  targets `postMessageTargetOrigin`, which DAA resolves from the partner's
  registered origins and the caller cannot supply — but that is
  the ceremony app's code, not this package's, and it is what makes the
  inbound `event.origin` check above meaningful rather than circular.

- **A fresh iframe element per ceremony.** Every ceremony loads the same URL,
  and the document keeps the first token it is handed, so a reused element
  would serve the previous ceremony.
- **The token is answered once, and only to a mounted frame.** A
  `token-request` that arrives before `mount()` returns has no frame to check
  `event.source` against, so it is ignored rather than counted as answered.
- **Height is applied from a timer.** `requestAnimationFrame` and a
  `ResizeObserver`'s first delivery are both tied to the frame being rendered,
  which a cross-origin iframe in normal page flow is not guaranteed to be.
- **The `payment` permission policy is always granted**, even with the SPC
  branch deferred: measured behavior is that enrollment in a cross-origin frame
  is gated by `payment`, not by `publickey-credentials-create`.
- **A ready timeout is `Transport`, not `Expired`.** The frame did not signal
  readiness, so the SDK cannot know whether the token was consumed. Request a
  fresh ceremony before retrying.

## Step-up

`approve()` runs the other ceremony kind. Same machine, same gates, same
verbatim relay — what differs is decided by DAA and rendered by the frame, not
here.

Three steps, **and the middle one is the only one that runs in the browser.**
They are separate blocks below because they run in separate places: this
package exists so that the code holding your API key and the code running the
ceremony are never the same program.

**① and ③ — your backend**, with `@circle-fin/daa-node-sdk`:

```ts
import { SCA_HEADERS } from '@circle-fin/daa-node-sdk'

// ① Open an intent-bound challenge.
const { challengeId, frameToken } = await daa.passkeys.openChallenge({
  clientEntityId,
  operation: 'TRANSFER',
  intent: transferRequestBody, // the gated route's own body
})
// → send frameToken to the page, and nothing else from this response

// ③ …and later, once the page has sent you the assertion back, resend the
//    gated request with your own HTTP client. Still your backend: this is
//    where the API key lives, and the only place it may.
await fetch(`${baseUrl}/v1/accounts/transfers`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    [SCA_HEADERS.challengeId]: challengeId,
    [SCA_HEADERS.assertion]: assertion,
  },
  body: JSON.stringify(transferRequestBody),
})
```

**② — the page**, with this package. No credential of any kind here:

```ts
// frameToken arrived from your backend. Not challengeId, and not `summary` —
// that is server-authored copy for your records. The frame fetches the copy
// the user approves independently, which is what stops you rendering your own
// pre-confirmation from untrusted text.
// `approve` returns the X-Sca-Assertion value directly — text, not the object.
const assertion = await sca.approve(frameToken, { mode: 'inline', container })
// → send `assertion` to your backend over your own authenticated channel
```

On Safari and iOS this runs in a Circle window, so call `approve` from the
click handler before awaiting anything, with `frameToken` as a promise if your
backend has not answered yet. See
[On Safari and iOS, ceremonies open a window](#on-safari-and-ios-ceremonies-open-a-window).

**The intent must be the same one.** Not the same bytes — DAA reparses and
canonicalizes both sides, so field order and whitespace are free — but the
same fields with the same values, `idempotencyKey` included, because that key
is inside the canonical intent. A retry under a _new_ idempotency key is a
different intent and needs a new challenge. One approval cannot be replayed
across two submissions; that is the point, and it is checked twice: against
the digest DAA stored and against the digest inside the signature.

⚠️ **`approve()` returns a string, and that is deliberate.** `X-Sca-Assertion`
is raw JSON text, and base64url of that JSON — an encoding an integrator could reasonably
expect — is rejected by name with `"assertion is not valid strict JSON"`.
Returning the finished header value removes that choice; returning the object
would leave every integrator to encode it, and one of them to encode it the
documented-wrong way.

It is the one place `approve` is asymmetric with `enroll`, and the asymmetry is
in the wire rather than in the SDK: an attestation goes into a JSON **body** as
an object, an assertion goes into a **header** as text. Each returns what its
destination takes. Serializing the envelope is safe, and DAA says so itself:
_"this outer envelope's JSON formatting carries no cryptographic weight — only
the base64url fields it carries do."_ Those fields are reproduced character for character.
`AuthenticationResponseJson` is still exported, so `JSON.parse` gives you a
typed object if you want to read one.

`TRANSFER`, `WITHDRAWAL` and `ADDRESS_BOOK_ADD` have SCA intent parsers today;
the rest of DAA's vocabulary comes back as `SCA_OPERATION_NOT_IMPLEMENTED`.

**Implemented is not enforced**, and the two lists move separately. Having a
parser means a challenge can be opened for that operation. Circle determines
whether a given request requires SCA; the SDK does not expose rollout state, so
a challenge you can open is not necessarily required for every request.

## Not built yet

| Item       | Blocked on                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------- |
| SPC branch | The server does not support SPC ceremonies yet. `capabilities()` reports `'unknown'`, not `false`. |
