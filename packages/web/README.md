# `@circle-fin/daa-web-sdk`

Browser SDK for Circle Digital Asset Accounts. It shows Circle's passkey
ceremony inside your web app, so your end users can register a passkey and
approve sensitive operations with it (Strong Customer Authentication, or SCA).

The SDK runs on your page and loads a ceremony document served from Circle's
own origin. The passkey ceremony happens inside that document, so your page
never sees the details Circle shows the user to approve. This package holds no
credentials and makes no calls to Circle's APIs. Your backend does that with
[`@circle-fin/daa-node-sdk`](https://github.com/circlefin/daa-node-sdk/blob/master/packages/node/README.md).

For the end-to-end integration flow, see
[How-to: Implement Strong Customer Authentication](https://developers.circle.com/digital-asset-accounts/howtos/strong-customer-authentication)
in Circle's developer documentation. This README is the reference for the
package itself.

- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Presentation: inline or modal](#presentation-inline-or-modal)
- [Safari and iOS](#safari-and-ios)
- [Approving an operation (step-up)](#approving-an-operation-step-up)
- [Error handling](#error-handling)
- [Security checklist](#security-checklist)
- [Page requirements (CSP, permissions, headers)](#page-requirements-csp-permissions-headers)
- [Support and security reporting](#support-and-security-reporting)

## Install

```bash
npm install @circle-fin/daa-web-sdk
```

The package is ESM-only and ships TypeScript types. Install it with a Node.js 22
or later toolchain and bundle it with your web app.

## Quick start

Registering a passkey is a round trip between your backend and your page:

1. Your backend calls `daa.passkeys.createRegistration(...)` and sends the
   `frameToken` to the page.
2. **Your page (this package)** calls `sca.enroll(frameToken, ...)`.
3. Your page sends the result to your backend, which calls
   `daa.passkeys.complete(...)`.

```ts
import { createScaClient, isScaError } from '@circle-fin/daa-web-sdk'

const sca = createScaClient({ environment: 'sandbox' })

async function registerPasskey(): Promise<void> {
  // Ask your backend to open a registration. It returns the frameToken and
  // keeps the registrationId on its side (for example in the user's session).
  // Do not await it here: pass the pending token straight to enroll.
  const frameToken = fetch('/api/passkeys/start', { method: 'POST' })
    .then((res) => res.json() as Promise<{ frameToken: string }>)
    .then((body) => body.frameToken)

  try {
    const attestationResponse = await sca.enroll(frameToken, { mode: 'modal' })

    // Send the result to your backend unchanged. Do not modify it.
    await fetch('/api/passkeys/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attestationResponse }),
    })
  } catch (error) {
    if (isScaError(error) && error.code === 'Cancelled') {
      // The user closed the dialog. Offer a retry.
      return
    }
    throw error
  }
}

document.getElementById('register-passkey')!.addEventListener('click', () => {
  void registerPasskey()
})
```

Call `registerPasskey` directly from the click handler, and do not `await`
anything before `enroll`. Safari and iOS need this to open the ceremony window.
See [Safari and iOS](#safari-and-ios).

The backend half of this example is in the
[server SDK guide](https://github.com/circlefin/daa-node-sdk/blob/master/packages/node/README.md#quick-start).

## Configuration

`createScaClient(config)` returns a client with `enroll`, `approve` and
`capabilities` methods. It throws a `TypeError` at construction if the
configuration is invalid.

| Field               | Required | Default     | Description                                                                                                           |
| ------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `environment`       | Yes      |             | `'sandbox'` or `'production'`. Selects the Circle ceremony origin.                                                    |
| `ceremonyPath`      | No       | `/ceremony` | Path of the ceremony document. Change it only if Circle tells you to. Must start with `/`, with no query or fragment. |
| `readyTimeoutMs`    | No       | `10000`     | How long to wait for the ceremony to signal it is ready.                                                              |
| `ceremonyTimeoutMs` | No       | `300000`    | Total time allowed for the ceremony once it is ready (5 minutes).                                                     |
| `resizeIntervalMs`  | No       | `250`       | How often the SDK applies the ceremony's requested height to the frame.                                               |
| `circleOrigin`      | No       |             | Overrides the ceremony origin. Leave it unset. See below.                                                             |

Durations must be finite positive numbers of milliseconds.

`environment` picks the Circle origin for you, so you never type a ceremony
host:

| `environment` | Ceremony origin                      |
| ------------- | ------------------------------------ |
| `sandbox`     | `https://daa-sca-sandbox.circle.com` |
| `production`  | `https://daa-sca.circle.com`         |

Use the same `environment` value as the one you pass to the server SDK.

`circleOrigin` exists only for local development and for a ceremony host that
Circle has explicitly given you. In that case keep `environment: 'sandbox'` and
set `circleOrigin` to the bare origin Circle provided (HTTPS, or
`http://localhost`). With `environment: 'production'` any other origin is
rejected. A wrong origin does not produce a clear error. The SDK ignores
messages from the real ceremony, and the call ends with a `Transport` error
after the ready timeout.

### Checking support

`sca.capabilities()` returns `{ protocolVersion, frame, securePaymentConfirmation }`.
`securePaymentConfirmation` is currently always `'unknown'`.

## Presentation: inline or modal

Both `enroll` and `approve` take a presentation that decides where the ceremony
appears. The ceremony itself is identical in both modes.

```ts
// Inline: you provide the element and the layout. The SDK sets the frame's height.
await sca.enroll(frameToken, {
  mode: 'inline',
  container: document.getElementById('sca')!,
})

// Modal: the SDK draws the dialog, including backdrop, close button, focus
// handling and scroll lock.
await sca.approve(frameToken, { mode: 'modal', title: 'Confirm your transfer' })
```

Modal options:

| Option        | Default                 | Description                                                                                                                 |
| ------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `title`       | `Circle security check` | The dialog's accessible name, announced by screen readers. It is not a visible heading. The visible text comes from Circle. |
| `dismissible` | `true`                  | Whether the close button, `Escape` and a click on the backdrop close the dialog. A dismissal rejects with `Cancelled`.      |

Notes:

- The modal adds no dependency and no stylesheet to import. It injects one
  `<style>` element the first time it is used. The panel is centered, `32rem`
  wide at most, and full width (less a gutter) on narrow screens.
- Style hooks: `.circle-sca-modal`, `.circle-sca-modal-overlay`,
  `.circle-sca-modal-panel`, `.circle-sca-modal-close`, and `.circle-sca-frame`
  on the iframe. The injected styles come first in `<head>`, so your own rules
  at equal specificity win.
- The dialog uses `z-index: 60`. If another widget on your page, such as a chat
  bubble or cookie banner, sits above that, raise `.circle-sca-modal`'s
  `z-index` in your own CSS.
- While a passkey prompt from the browser or a password manager is open, the
  close button stays active, and using it cancels the ceremony. Set
  `dismissible: false` to prevent that. The user can still cancel inside the
  ceremony itself.

### Canceling from your code

Pass an `AbortSignal` as the third argument to either method:

```ts
import { isScaError } from '@circle-fin/daa-web-sdk'

async function enrollWithCancel(): Promise<void> {
  const controller = new AbortController()
  cancelButton.addEventListener('click', () => controller.abort())

  try {
    await sca.enroll(frameToken, { mode: 'modal' }, { signal: controller.signal })
  } catch (error) {
    if (isScaError(error) && error.code === 'Cancelled') return
    throw error
  }
}
```

Aborting removes the frame immediately and rejects with `Cancelled`. It only
affects the browser. It does not cancel anything on Circle's side, and a result
that was already on its way can still be recorded. Before you retry an
operation that moves funds, check your backend's own state.

## Safari and iOS

Safari on macOS, and every browser on iOS and iPadOS, cannot run these
ceremonies inside a cross-origin iframe. On those browsers `enroll` and
`approve` open the ceremony in a separate window on Circle's origin instead.
Your `presentation` argument is accepted but nothing is drawn in your page. All
other browsers keep using the frame.

To work in both cases, write your code like this. It behaves the same on every
browser:

- **Call `enroll` or `approve` directly from the click handler, and pass the
  token as a promise.** Browsers only allow opening a window while handling a
  click, and awaiting a `fetch` first can use up that allowance. The SDK opens
  the window immediately and loads the ceremony when the promise resolves.

  ```ts
  button.addEventListener('click', () => {
    const frameToken = fetch('/api/passkeys/start', { method: 'POST' })
      .then((res) => res.json())
      .then((body: { frameToken: string }) => body.frameToken)

    sca.enroll(frameToken, { mode: 'modal' }).then(onEnrolled, onError)
  })
  ```

  If you `await` before calling, the browser can block the window, for example
  when your backend is slow to respond. The call then rejects with
  `Unsupported`. If your token promise rejects, the SDK rethrows that error
  unchanged.

- **Do not send `Cross-Origin-Opener-Policy: same-origin`** on the page that
  calls `enroll` or `approve`. It disconnects the window from your page, so the
  ceremony cannot complete.

Closing the window rejects with `Cancelled`, the same as dismissing the modal.

## Approving an operation (step-up)

`approve()` runs the ceremony that lets a user approve one specific operation,
such as a transfer. It works like `enroll()`, with two differences. Your backend
opens a challenge with `daa.passkeys.openChallenge(...)` instead of a
registration, and `approve()` returns a **string** instead of an object.

```ts
// frameToken came from your backend. Send nothing else from the challenge
// response to the page, in particular not the summary.
const assertion = await sca.approve(frameToken, { mode: 'modal' })

// Send `assertion` to your backend over your own authenticated channel.
await fetch('/api/transfers/approve', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ assertion }),
})
```

Your backend then sends the original request to Circle with the assertion in
the `X-Sca-Assertion` header and the challenge ID in `X-Sca-Challenge-Id`. See
[Approving an operation](https://github.com/circlefin/daa-node-sdk/blob/master/packages/node/README.md#approving-an-operation-step-up)
in the server SDK guide for the full sequence.

Things to know:

- **The assertion is raw JSON text, and it must stay that way.** Circle rejects
  a base64url-encoded copy with `assertion is not valid strict JSON`.
  `approve()` returns the finished header value so you do not have to encode
  it. Pass the string through untouched. If you want to read fields from it,
  `JSON.parse` it into the exported `AuthenticationResponseJson` type, but
  forward the original string.
- **The approved request must match the challenge.** Your backend must send the
  same request body it passed to `openChallenge`, including its
  `idempotencyKey`. A different body needs a new challenge.
- **The user sees what Circle shows, not what you show.** The details the user
  approves are loaded by the ceremony directly from Circle. Do not build your
  own confirmation screen from data in your backend's challenge response.
- A challenge is valid for five minutes. If it has expired by the time the
  user acts, ask your backend for a new one.

## Error handling

Every failure from `enroll` and `approve` is a `ScaError` with a `code`. Check
it with `isScaError(error)`. The codes are the same in Circle's web, Android,
iOS and React Native SDKs.

| Code              | Meaning                                                                                                   | What to do                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Cancelled`       | The user dismissed or declined, or your code aborted.                                                     | Not an error state. Offer a retry. Check backend state before retrying a payment.           |
| `Expired`         | The ceremony expired or was already used.                                                                 | Ask your backend for a new registration or challenge, then retry once.                      |
| `Unsupported`     | No user-verifying authenticator, or the surface is unavailable (for example, a blocked window on Safari). | Offer your fallback.                                                                        |
| `NotEnrolled`     | The user has no active passkey.                                                                           | Send the user through enrollment.                                                           |
| `AlreadyEnrolled` | The user already has a passkey.                                                                           | Use `approve` instead of `enroll`.                                                          |
| `Transport`       | Network failure, Circle unreachable, or the ceremony never signaled ready.                                | The token may have been used. Ask your backend for a new one before retrying.               |
| `Protocol`        | The ceremony and this SDK version do not understand each other.                                           | Retrying will not help. Update to the latest SDK version and contact Circle if it persists. |

`Cancelled` and `Unsupported` are separate on purpose. Browsers often report
both as the same generic "not allowed" error. The SDK tells them apart so you
can offer a retry for one and a fallback for the other.

Errors from your own backend calls (such as `fetch` rejecting) are not
`ScaError` values. Handle them separately.

## Security checklist

- **Never put your Circle API key in browser code.** This package does not need
  it and never will. Your backend holds it.
- **Pass the SDK only the `frameToken`.** It is a one-time capability for a
  single pending ceremony. Treat it as a secret: fetch it over your own
  authenticated channel, do not put it in a URL, and do not log, store or
  forward it. The SDK deliberately keeps it out of the iframe URL, because URLs
  are visible to analytics scripts and session-replay tools. It still passes
  through your page's JavaScript on the way to the SDK, so be careful with any
  tooling that records function arguments or network responses.
- **Relay results unchanged.** Send the `enroll` result and the `approve`
  string to your backend exactly as returned.
- **Authenticate the hop to your backend.** The endpoints that receive these
  results must confirm the signed-in user is the one the ceremony was opened
  for.
- **Do not handle the ceremony's `postMessage` traffic yourself.** The SDK
  checks the origin and the source window of every message. Reimplementing that
  invites mistakes.
- **Use only the root import** (`@circle-fin/daa-web-sdk`). The `/protocol`
  and `/testing` subpaths are for Circle's own ceremony app and for test
  doubles. They are not supported for integrators, and `/testing` must never be
  used in production.

## Page requirements (CSP, permissions, headers)

- **Content-Security-Policy:** allow the ceremony origin for your environment
  in `frame-src` (or `child-src`), for example `frame-src https://daa-sca.circle.com`
  for production and `https://daa-sca-sandbox.circle.com` for sandbox. The
  Safari and iOS window flow opens a top-level window, which `frame-src` does
  not govern.
- **Inline styles:** the modal injects a `<style>` element without a nonce. If
  your policy restricts `style-src`, allow it, or use `inline` mode and style the
  container yourself.
- **Permissions-Policy:** the SDK sets the iframe's `allow` attribute for you
  (`publickey-credentials-get`, `publickey-credentials-create` and `payment`,
  scoped to Circle's origin). Do not write one yourself. If your page sends a
  `Permissions-Policy` header, it must not block those features for Circle's
  ceremony origin.
- **Cross-Origin-Opener-Policy:** do not use `same-origin` on pages that start a
  ceremony. See [Safari and iOS](#safari-and-ios).
- **Registered origin:** your backend passes the page's origin as `embedOrigin`
  when it opens a registration or challenge. It must be an origin Circle has
  registered for you, and the ceremony only works when it is shown on that
  origin.
- **Referrer:** the SDK sets `referrerPolicy="strict-origin"` on the frame, so
  only your site's origin is sent to Circle, never the full page URL.
- **Server-side rendering:** `createScaClient` and the ceremony methods need a
  browser. Create the client and call `enroll` or `approve` only in client-side
  code.

## Support and security reporting

- Integration guide: [How-to: Implement Strong Customer Authentication](https://developers.circle.com/digital-asset-accounts/howtos/strong-customer-authentication)
- API reference: [Digital Asset Accounts](https://developers.circle.com/api-reference/digital-asset-accounts)
- Integration questions: contact your Circle representative.
- Bugs in this SDK: open a GitHub issue.
- Security vulnerabilities: do not file a public issue. Report them privately
  through Circle's [Vulnerability Disclosure Program](https://hackerone.com/circle-bbp).
  See [SECURITY.md](https://github.com/circlefin/daa-node-sdk/blob/master/SECURITY.md).

## License

[Apache License 2.0](https://github.com/circlefin/daa-node-sdk/blob/master/LICENSE)
