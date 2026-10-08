# `@circle-fin/daa-node-sdk`

Server-side SDK for Circle Digital Asset Accounts. It wraps the passkey
endpoints under `/v1/accounts/passkeys`, which you call with your Circle API
key, so that your end users can register passkeys and approve sensitive
operations with them (Strong Customer Authentication, or SCA).

**This package holds your Circle API key. Use it only on your backend, never in
browser code.** The browser half of the flow is
[`@circle-fin/daa-web-sdk`](https://github.com/circlefin/daa-node-sdk/blob/master/packages/web/README.md), which never holds a credential.

For the end-to-end integration flow, see
[How-to: Implement Strong Customer Authentication](https://developers.circle.com/digital-asset-accounts/howtos/strong-customer-authentication)
in Circle's developer documentation. This README is the reference for the
package itself.

- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Approving an operation (step-up)](#approving-an-operation-step-up)
- [Error handling](#error-handling)
- [Security checklist](#security-checklist)
- [Support and security reporting](#support-and-security-reporting)

## Install

```bash
npm install @circle-fin/daa-node-sdk
```

Requires Node.js 22 or later. The package is ESM-only.

## Quick start

Registering a passkey takes three steps. Steps 1 and 3 run in this package on
your backend. Step 2 runs in the browser with
[`@circle-fin/daa-web-sdk`](https://github.com/circlefin/daa-node-sdk/blob/master/packages/web/README.md).

```
1. daa.passkeys.createRegistration(...)   your backend   (holds the API key)
   -> send frameToken to your page         the only value that crosses
2. sca.enroll(frameToken, ...)            your web app   (holds no credentials)
   -> send the result to your backend
3. daa.passkeys.complete(...)             your backend   (holds the API key)
```

Backend:

```ts
import { randomUUID } from 'node:crypto'
import { createDaaClient } from '@circle-fin/daa-node-sdk'

const daa = createDaaClient({
  environment: 'sandbox',
  apiKey: process.env.CIRCLE_API_KEY!,
})

// Step 1. Open a registration for one of your end users.
const { registrationId, frameToken } = await daa.passkeys.createRegistration({
  clientEntityId, // the end user's client entity ID
  idempotencyKey: randomUUID(),
  embedOrigin: 'https://app.example.com', // the page that will show the ceremony
})

// Send ONLY frameToken to the page. Keep registrationId on your side, for
// example in the user's session, so you can pair it with the result in step 3.

// Step 3. After the page sends back the result of sca.enroll(), submit it
// exactly as received.
const { passkeyId, credentialId } = await daa.passkeys.complete({
  registrationId,
  attestationResponse, // the unmodified object from the browser
})
```

Browser (step 2), using the web SDK:

```ts
import { createScaClient } from '@circle-fin/daa-web-sdk'

const sca = createScaClient({ environment: 'sandbox' })
const attestationResponse = await sca.enroll(frameToken, {
  mode: 'modal',
})
// Send attestationResponse to your backend unchanged.
```

A registration is open for ten minutes. If it expires before you call
`complete`, open a new one.

## Configuration

`createDaaClient(config)` accepts the following fields.

| Field                   | Required | Default | Description                                                                                                      |
| ----------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `environment`           | Yes      |         | `'sandbox'` or `'production'`. Selects the API host.                                                             |
| `apiKey`                | Yes      |         | Your Circle API key. Must not be empty.                                                                          |
| `euRestricted`          | No       | `false` | Set to `true` if Circle told you your API keys are EU-restricted. See [EU-restricted keys](#eu-restricted-keys). |
| `timeoutMs`             | No       | `30000` | Per-request timeout for the default transport, an integer from 1 to 2147483647.                                  |
| `transport`             | No       | `fetch` | Your own HTTP function. Needed for [mTLS](#mtls), custom retry or tracing. It must enforce its own timeout.      |
| `baseUrl`               | No       |         | Overrides the API origin. Use only a value Circle gave you. See below.                                           |
| `allowNonCircleBaseUrl` | No       |         | Set to `true` to allow a `baseUrl` that is not on `circle.com`, or `http://localhost` for local development.     |

The client throws a `TypeError` at construction for an invalid `environment`,
`apiKey`, `timeoutMs` or `baseUrl`, so configuration mistakes surface at
startup rather than on the first request. `timeoutMs` is checked only when you
use the default transport. With your own `transport` it is ignored.

### Environments

`environment` selects the API host. Use the same value in the web SDK so that
both halves target the same Circle environment.

| `environment` | API origin                       | Ceremony origin used by the web SDK  |
| ------------- | -------------------------------- | ------------------------------------ |
| `sandbox`     | `https://api-sandbox.circle.com` | `https://daa-sca-sandbox.circle.com` |
| `production`  | `https://api.circle.com`         | `https://daa-sca.circle.com`         |

Use a sandbox API key with `sandbox` and a production API key with
`production`.

`baseUrl` replaces the API origin outright. Prefer `environment` and
`euRestricted` over typing a host yourself. `baseUrl` must be a bare origin
(no path, query, fragment or credentials) on `circle.com` or a subdomain. For
another HTTPS origin that Circle gave you, also set
`allowNonCircleBaseUrl: true`. The client sends your API key to the configured
host, so never point it at an origin you do not trust.

### EU-restricted keys

If Circle told you that your API keys are EU-restricted, set
`euRestricted: true`. It selects the EU-residency endpoint for your
environment:

| `environment` | Host with `euRestricted: true`      |
| ------------- | ----------------------------------- |
| `sandbox`     | `https://api-sandbox-eu.circle.com` |
| `production`  | `https://api-eu.circle.com`         |

The SDK cannot tell whether your key is EU-restricted. If you are not sure, ask
Circle. A key without EU restrictions works on either host, so setting the flag
unnecessarily is harmless. Leaving it unset for an EU-restricted key makes
every authenticated request fail with `403` and the message
`This account must use the EU API endpoint.` That failure does not look like a
passkey error, so check this setting first if everything is forbidden.

An EU-restricted key also requires a client certificate (mTLS). See
[mTLS](#mtls). You need both settings. Residency is checked first, so the
residency message does not confirm that your certificate is set up correctly.
Fix the host, then test again.

| Your key       | Host   | Certificate | Result                                             |
| -------------- | ------ | ----------- | -------------------------------------------------- |
| EU-restricted  | EU     | Yes         | `200`                                              |
| EU-restricted  | EU     | No          | `403 "Valid mTLS client certificate required."`    |
| EU-restricted  | non-EU | Either      | `403 "This account must use the EU API endpoint."` |
| Not restricted | Either | Either      | `200`                                              |

### mTLS

If your API key requires mTLS, every request must present a client certificate.
Node's global `fetch` cannot do that, so supply a `transport`. This example
uses [`undici`](https://www.npmjs.com/package/undici):

```ts
import { Agent, fetch } from 'undici'
import { createDaaClient, DaaTransportError } from '@circle-fin/daa-node-sdk'

const agent = new Agent({ connect: { cert, key } }) // your PEM certificate and key

const daa = createDaaClient({
  environment: 'production',
  euRestricted: true,
  apiKey: process.env.CIRCLE_API_KEY!,
  transport: async ({ method, url, headers, body }) => {
    try {
      const res = await fetch(url, { method, headers, body, dispatcher: agent })
      return { status: res.status, body: await res.text() }
    } catch (cause) {
      // Report network and TLS failures as DaaTransportError, like the default transport.
      throw new DaaTransportError(`Request to ${url} failed`, { cause })
    }
  },
})
```

A custom transport owns timeouts, retries and tracing. The SDK does not retry
requests on its own, and it passes errors thrown by your transport through
unchanged. Throw `DaaTransportError` for network and TLS failures, as above, so
that they are not mistaken for the `TypeError` the SDK uses for invalid input. The transport receives your API key in
`headers.authorization`, so do not log request headers or include them in
errors you throw from the transport.

### Rate limits

The passkey endpoints are rate-limited, so a `429` response can reach you as a
`DaaApiError`. The response has no `Retry-After` header, so choose your own
back-off.

## API reference

All methods are on `daa.passkeys`, return promises, and unwrap Circle's
`{ "data": ... }` response envelope for you.

| Method                                              | HTTP request                               | Returns                                                        |
| --------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| `createRegistration(request)`                       | `POST /v1/accounts/passkeys/registrations` | `{ registrationId, expiresAt, frameToken }`                    |
| `complete({ registrationId, attestationResponse })` | `POST /v1/accounts/passkeys`               | `{ passkeyId, credentialId }`                                  |
| `list({ clientEntityId })`                          | `GET /v1/accounts/passkeys`                | Array of passkeys, including revoked ones (`revokedDate` set)  |
| `status({ clientEntityId })`                        | `GET /v1/accounts/passkeys`                | `{ sca, passkeys }`: whether SCA is required, and the passkeys |
| `revoke(passkeyId, { clientEntityId })`             | `DELETE /v1/accounts/passkeys/{passkeyId}` | Nothing. Revoking marks the passkey revoked.                   |
| `openChallenge(request)`                            | `POST /v1/accounts/passkeys/challenges`    | `{ challengeId, expiresAt, summary, frameToken }`              |

### `createRegistration`

| Field            | Required | Description                                                                             |
| ---------------- | -------- | --------------------------------------------------------------------------------------- |
| `clientEntityId` | Yes      | The end user. It must belong to your entity.                                            |
| `idempotencyKey` | Yes      | A unique value per registration attempt, such as a UUID.                                |
| `embedOrigin`    | No       | The origin of your page that shows the ceremony, for example `https://app.example.com`. |
| `spcCapable`     | No       | Leave unset unless Circle tells you otherwise.                                          |

**Always send `embedOrigin`.** It must exactly match one of the web app origins
Circle has registered for you (scheme, host and port, with no trailing slash
or path, at most 512 characters). The ceremony is bound to that origin. With a
single registered origin, omitting it works, but the call starts failing with
`API_PARAMETER_INVALID` (`code: 2`) as soon as you register a second origin. A
blank value, or a value that matches none of your registered origins, returns
the same error. If you have no registered origin at all, you get
`SCA_ORIGIN_NOT_CONFIGURED` (`420064`).

The same `embedOrigin` rules apply to `openChallenge`.

#### Retrying and idempotency

Calling `createRegistration` again with the same `idempotencyKey` returns the
same registration (same `registrationId` and `expiresAt`) with a **new
`frameToken`**, and the previous token stops working.

- Retrying after a network failure where you never received a response is
  safe.
- **Do not retry with the same key after you have given the token to the
  page.** The retry succeeds and looks like a clean replay, but the ceremony
  your user is in the middle of stops working, and nothing in the response
  says so. If you need to restart, use a new `idempotencyKey`.

Reusing a key with a different `spcCapable` or `embedOrigin` value returns
`IDEMPOTENCY_KEY_REUSED` (HTTP `409`).

- An omitted `spcCapable` counts as `false`.
- Omitting `embedOrigin` on a retry is not a conflict. The original ceremony
  comes back, still bound to the origin it was opened for.

### `complete`

Pass `attestationResponse` exactly as the web SDK's `enroll()` returned it.
Re-serializing or modifying it invalidates the signature.

A `registrationId` that does not exist, or that belongs to another entity,
returns `404` with `PASSKEY_REGISTRATION_NOT_FOUND` (`420065`).

### `list`, `status` and `revoke`

All three take the `clientEntityId` of the end user who owns the passkey.
`status` makes the same request as `list` and also returns `sca`:
`{ required: true }` when Circle requires SCA for that end user,
`{ required: false }` when it does not, and `null` when that is unknown. Treat
`null` as unknown, not as "not required": a protected call still answers `428`
whenever SCA is required. A
`passkeyId` must be 1 to 128 letters, digits, underscores or hyphens; anything
else throws a `TypeError` before a request is sent.

## Approving an operation (step-up)

After a user has registered a passkey, you can require them to approve an
operation with it. The sequence has four steps and the final request is yours:

1. **Your backend** calls `daa.passkeys.openChallenge(...)` with the exact
   request you intend to send, and sends only the `frameToken` to the page.
2. **Your web app** calls `sca.approve(frameToken, ...)` from
   `@circle-fin/daa-web-sdk`. It returns the assertion as a string.
3. The page sends that string to your backend over your own authenticated
   channel.
4. **Your backend** sends the original request to Circle with two extra
   headers.

```ts
import { SCA_HEADERS } from '@circle-fin/daa-node-sdk'

// Step 1. `transferBody` is the request body you will send to the gated route.
const { challengeId, frameToken } = await daa.passkeys.openChallenge({
  clientEntityId,
  operation: 'TRANSFER',
  intent: transferBody,
  embedOrigin: 'https://app.example.com',
})
// Send frameToken to the page. Keep challengeId on your side.

// Step 4. `assertion` is the string the page returned from sca.approve().
await fetch('https://api-sandbox.circle.com/v1/accounts/transfers', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
    'content-type': 'application/json',
    [SCA_HEADERS.challengeId]: challengeId, // X-Sca-Challenge-Id
    [SCA_HEADERS.assertion]: assertion, // X-Sca-Assertion
  },
  body: JSON.stringify(transferBody), // the same body, not a rebuilt one
})
```

This SDK never sends the gated request. You send it with your own HTTP client,
so use the API origin for your environment (see [Environments](#environments)).

### `openChallenge` fields

| Field            | Required | Description                                                                                                                        |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `clientEntityId` | Yes      | The end user approving the operation.                                                                                              |
| `operation`      | Yes      | The operation, as an uppercase name: `TRANSFER`, `WITHDRAWAL`, `WIRE_ACCOUNT_CREATE`, `ADDRESS_BOOK_ADD` or `ADDRESS_BOOK_DELETE`. |
| `intent`         | Yes      | The gated route's own request body, verbatim. Use `{}` for `ADDRESS_BOOK_DELETE`, which has no body.                               |
| `pathParameters` | No       | Path parameters for an operation whose subject is in the URL. Used by `ADDRESS_BOOK_DELETE`.                                       |
| `embedOrigin`    | No       | Same rules as for `createRegistration`. Always send it.                                                                            |

The operations correspond to these routes:

| `operation`           | Gated request                         |
| --------------------- | ------------------------------------- |
| `TRANSFER`            | `POST /v1/accounts/transfers`         |
| `WITHDRAWAL`          | `POST /v1/accounts/withdrawals`       |
| `WIRE_ACCOUNT_CREATE` | `POST /v1/banks/wires`                |
| `ADDRESS_BOOK_ADD`    | `POST /v1/addresses/recipient`        |
| `ADDRESS_BOOK_DELETE` | `DELETE /v1/addresses/recipient/{id}` |

Any other operation name returns `SCA_OPERATION_NOT_IMPLEMENTED` (`420062`).

Rules that matter:

- **Send the identical body.** The challenge is bound to the intent you passed,
  including its `idempotencyKey`. If you send a different body, or the same
  body under a new `idempotencyKey`, it is a different intent and needs a new
  challenge. One approval cannot be reused for two submissions.
- **For `ADDRESS_BOOK_DELETE`, name the recipient in `pathParameters`.** Pass
  `intent: {}` and `pathParameters: { id: recipientId }`. The key must be
  exactly `id`. Any other key makes `openChallenge` fail with
  `API_PARAMETER_INVALID` (`code: 2`). Use the same string that you put in the
  `DELETE` URL, written as a canonical UUID. Circle rejects other spellings
  instead of normalizing them. The SDK does not check these rules. Circle does.
- **Check field names against the gated route's own documentation.** Circle
  does not reject an unrecognized field in a body-carrying intent. A
  misspelled field is dropped from the summary your user approves, but it is
  still covered by what they sign.
- **Pass the assertion through as text.** The value from `sca.approve()` is raw
  JSON text. Do not base64url-encode it, or the request fails with
  `assertion is not valid strict JSON`.
- **Do not render `summary` yourself.** The response includes a `summary` for
  your records. The ceremony shows the user a summary that Circle fetches
  independently. Do not build your own confirmation screen from `summary`.
- A challenge is valid for five minutes.

Whether Circle requires SCA for a particular request is Circle's
determination for the end user's entity. A request that does not require SCA
succeeds without the headers. If you believe a request should have required
SCA and did not, contact Circle.

## Error handling

The SDK throws three kinds of error.

| Error               | When                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DaaApiError`       | Circle answered with a non-2xx status, or a 2xx response without a `data` payload. Has `status`, `code`, `message` and `rawBody`.                   |
| `DaaTransportError` | The request failed before a usable response: DNS, TLS, timeout or connection reset. The request may or may not have been applied.                   |
| `TypeError`         | Invalid input, such as a bad `environment`, `baseUrl` or `apiKey`, or an empty `passkeyId`. No request was sent. This is a bug in the calling code. |

Check them with `isDaaApiError(error)` and `isDaaTransportError(error)`.

`DaaApiError.code` is Circle's numeric public error code. It is a plain
`number | undefined`, not a closed union, because Circle can add codes at any
time. `DAA_ERROR_CODES` provides named constants:

```ts
import { DAA_ERROR_CODES, isDaaApiError } from '@circle-fin/daa-node-sdk'

try {
  await daa.passkeys.complete({ registrationId, attestationResponse })
} catch (error) {
  if (isDaaApiError(error) && error.code === DAA_ERROR_CODES.PASSKEY_REGISTRATION_EXPIRED) {
    // The registration expired. Start again with a new createRegistration call.
  } else {
    throw error
  }
}
```

Codes you are most likely to branch on:

| Constant                                | Code     | Raised by                              | What to do                                                                                                            |
| --------------------------------------- | -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `CLIENT_ENTITY_NOT_OWNED`               | `420001` | Any call that takes a `clientEntityId` | The ID is not an end user of your entity. It is also what you get if the end user has not completed account creation. |
| `IDEMPOTENCY_KEY_REUSED`                | `420034` | `createRegistration`                   | The key was used with different parameters. Use a new key.                                                            |
| `PASSKEY_REGISTRATION_NOT_FOUND`        | `420065` | `complete`                             | The `registrationId` does not exist or belongs to another entity.                                                     |
| `PASSKEY_REGISTRATION_EXPIRED`          | `420051` | `complete`                             | The registration is older than ten minutes. Nothing was registered. Open a new one.                                   |
| `PASSKEY_REGISTRATION_CONSUMED`         | `420052` | `complete`                             | The registration was already completed.                                                                               |
| `PASSKEY_CREDENTIAL_ALREADY_REGISTERED` | `420053` | `complete`                             | This authenticator credential is already registered. Route the user to step-up instead of enrollment.                 |
| `SCA_ASSERTION_INVALID`                 | `420046` | `complete`, and the gated request      | The submitted ceremony result did not verify. Open a new ceremony.                                                    |
| `SCA_OPERATION_NOT_IMPLEMENTED`         | `420062` | `openChallenge`                        | The `operation` is not one of the supported names above.                                                              |
| `SCA_ORIGIN_NOT_CONFIGURED`             | `420064` | `createRegistration`, `openChallenge`  | No web app origin is registered for you. Contact Circle.                                                              |

`DAA_ERROR_CODES` also contains codes for the gated request, such as
`SCA_ASSERTION_REQUIRED` (`420058`), `SCA_INTENT_MISMATCH` (`420047`),
`SCA_CHALLENGE_EXPIRED` (`420054`) and `SCA_CHALLENGE_CONSUMED` (`420055`).
Treat each as "this challenge cannot be used; open a new one."

Other values of `code` to handle:

- `2` is `API_PARAMETER_INVALID`: a request field is wrong. The `message` says
  which.
- An authentication failure carries the HTTP status as its `code` (`401`), not
  a `4200xx` value.
- `-1` means the gateway did not recognize the upstream response. The
  `message` contains an `errId`. Give that identifier to Circle support.
- `undefined` means the body had no numeric `code`. An HTML error page from a
  proxy does this. So does `revoke` for a passkey that does not exist, which
  returns a plain `404`. Inspect `status` and `rawBody`.

The `message` text is written for callers and is safe to act on. Your API key
never appears in an error message. `rawBody` holds the upstream response
verbatim, so apply your normal redaction rules before you log it.

## Security checklist

- **Keep the API key on your server.** Load it from your secret manager or an
  environment variable. Never put it in a browser bundle, a mobile app or a
  repository.
- **Send the browser only the `frameToken`.** Do not send `registrationId`,
  `challengeId`, `summary` or anything else from these responses to the page.
- **Treat `frameToken` as a secret.** It lets its holder read one pending
  ceremony. Do not log it or put it in a URL. Deliver it to the page over your
  own authenticated channel.
- **Do not log API responses or `rawBody` unredacted.**
- **Relay browser results unchanged.** Do not parse, re-serialize or re-encode
  the `attestationResponse` or the assertion.
- **Authenticate the browser-to-backend hop yourself.** Your endpoints that
  receive the ceremony result must check that the request comes from the
  signed-in user the registration or challenge was opened for.
- **Only point `baseUrl` at hosts you trust.** The client sends your API key to
  it.

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
