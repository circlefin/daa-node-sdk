# `@circle-fin/daa-node-sdk`

Server-side SDK for Digital Asset Accounts — the API-key authenticated
endpoints.

**This package holds your Circle API key. Nothing here belongs in front-end
code.** The browser half is [`@circle-fin/daa-web-sdk`](../web), which never
holds a credential. They are the two ends of one flow:

```
① daa.passkeys.createRegistration(…)   ← this package   (holds the API key)
② hand `frameToken` to the page        ← the only thing that crosses
◆ sca.enroll(frameToken, presentation) ← @circle-fin/daa-web-sdk (holds nothing)
③ daa.passkeys.complete(…)             ← this package   (holds the API key)
```

## Usage

```ts
import { createDaaClient } from '@circle-fin/daa-node-sdk'

const daa = createDaaClient({
  environment: 'sandbox',
  apiKey: process.env.CIRCLE_API_KEY!,
})

// ① Open an enrollment ceremony.
const { registrationId, frameToken } = await daa.passkeys.createRegistration({
  clientEntityId,
  idempotencyKey: crypto.randomUUID(),
})

// ② Hand ONLY frameToken to the page. Not registrationId, not the rest.
//    The ceremony's summary is fetched by the Circle frame from Circle, which
//    is what keeps it out of your code.

// ③ Submit what the browser produced, relayed verbatim.
const { passkeyId } = await daa.passkeys.complete({ registrationId, attestationResponse })
```

`environment` is one of `smokebox`, `sandbox`, `staging`, `production` — the
same list and the same field name as the other DAA SDKs, including the web
SDK's `ScaSdkConfig`. It selects the API origin:

| `environment` | API origin                        | ceremony origin the web SDK pairs with it |
| ------------- | --------------------------------- | ----------------------------------------- |
| `smokebox`    | `https://api-smokebox.circle.com` | `https://daa-sca-smokebox.circle.com`     |
| `sandbox`     | `https://api-sandbox.circle.com`  | `https://daa-sca-sandbox.circle.com`      |
| `staging`     | `https://api-staging.circle.com`  | `https://daa-sca-staging.circle.com`      |
| `production`  | `https://api.circle.com`          | `https://daa-sca.circle.com`              |

Both SDKs deriving their hosts from one `environment` is what stops a pair of
hand-written hostnames from ending up on two different deployments.

### If Circle told you your API keys are EU-restricted

Set `euRestricted: true`. It selects the EU-residency endpoint for your
environment:

| `environment` | with `euRestricted: true`           |
| ------------- | ----------------------------------- |
| `sandbox`     | `https://api-sandbox-eu.circle.com` |
| `staging`     | `https://api-staging-eu.circle.com` |
| `production`  | `https://api-eu.circle.com`         |
| `smokebox`    | _no EU endpoint — throws_           |

**This matters more than it looks.** The API gateway rejects an EU-restricted
key arriving on any host outside its EU allowlist **fail-closed, with `403`, on
every authenticated request** — before any route in this SDK is reached. So the
wrong host does not surface as a passkey error; it surfaces as everything being
forbidden. EU residency and SCA eligibility are separate decisions.

The SDK cannot infer whether your key is EU-restricted. If Circle tells you
that it is, set `euRestricted: true`; otherwise leave it unset. A key without
EU restrictions works on either host, so enabling the option unnecessarily is
harmless. Leaving it unset for an EU-restricted key causes the blanket `403`.

**If you set it, you also need a client certificate.** An EU-restricted key
also requires mTLS, and the default `fetch` transport cannot present a
certificate. See [mTLS](#mtls) below; you need both pieces or neither works.

The two checks are independent and evaluated **residency first**:

| Your key      | Host   | Certificate | Result                                             |
| ------------- | ------ | ----------- | -------------------------------------------------- |
| EU-restricted | EU     | yes         | `200`                                              |
| EU-restricted | EU     | no          | `403 "Valid mTLS client certificate required."`    |
| EU-restricted | non-EU | yes         | `403 "This account must use the EU API endpoint."` |
| EU-restricted | non-EU | no          | `403 "This account must use the EU API endpoint."` |
| neither       | either | either      | `200`                                              |

Note the last EU-restricted row: on the wrong host you get the **residency**
message even when you have no certificate at all, because residency is checked
first. So that message does not tell you your certificate setup is correct —
fix the host, then retest.

`baseUrl` overrides the origin outright. Prefer `euRestricted` over hand-typing
an EU host — a hostname you type is a hostname you can typo, and this one fails
as a blanket `403`. By default, `baseUrl` must use `circle.com` or a subdomain.
For a non-Circle HTTPS origin explicitly provided by Circle, set
`allowNonCircleBaseUrl: true`. That same opt-in is required for
`http://localhost` during local development. The client sends the entity API
key to the configured host, so do not use an origin you do not trust.

The default fetch transport aborts a request after 30 seconds. Set `timeoutMs`
to change that deadline. If you inject a custom `transport`, it must enforce
its own timeout.

## Surface

Five routes, and exactly the five the API gateway exposes under
`/v1/accounts/passkeys`.

| Method                        | Route                                      |
| ----------------------------- | ------------------------------------------ |
| `passkeys.createRegistration` | `POST /v1/accounts/passkeys/registrations` |
| `passkeys.complete`           | `POST /v1/accounts/passkeys`               |
| `passkeys.list`               | `GET /v1/accounts/passkeys`                |
| `passkeys.revoke`             | `DELETE /v1/accounts/passkeys/{passkeyId}` |
| `passkeys.openChallenge`      | `POST /v1/accounts/passkeys/challenges`    |

**Use the public path shown above.** Adding a `/daa` segment produces a 404.

### Two routes are deliberately absent

- **`POST …/challenges/{id}/validate`** is not part of the public API. The API
  validates challenges as part of gated money-movement requests.
- **`GET /v1/daa/frame/ceremony`** is called by the Circle ceremony frame with
  a capability token, not an API key.

## Step-up

`passkeys.openChallenge` opens an intent-bound challenge; the browser runs the
ceremony with the `frameToken`; then **you resend the gated request yourself**,
with two headers:

| Header                    | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| `SCA_HEADERS.challengeId` | `challengeId` from `openChallenge`                    |
| `SCA_HEADERS.assertion`   | what `@circle-fin/daa-web-sdk`'s `approve()` returned |

`SCA_HEADERS` is exported so these are not names you type. **None of them are
sent by this SDK** — the gated request is yours, on your own route, with your
own client.

The assertion is **raw JSON text**, not base64url of it. DAA feeds the string
straight to its JSON reader and base64url-decodes only the fields inside
(`rawId`, `response.clientDataJSON`, `response.authenticatorData`,
`response.signature`); a base64url-encoded envelope fails with `"assertion is
not valid strict JSON"`. The web SDK's `approve()` returns the header value
already serialized, for exactly this reason.

### Name the page that hosts the ceremony

`createRegistration` and `openChallenge` both take an optional `embedOrigin`:
the origin of your page that embeds the ceremony, for example
`https://app.example.com`. It must exactly match one of the origins Circle has
approved for you, and the ceremony is bound to it. If that origin is removed
from your approved origins before the ceremony completes, the ceremony fails.

**Send it on every call.** Once you have more than one approved origin (two
web apps, say), a call without it fails with
`API_PARAMETER_INVALID` (`code: 2`), because nothing else says which page the
ceremony runs from. With one approved origin, omitting it uses that one, but
the integration then breaks the day a second origin is approved. A blank value,
or one that matches none of your approved origins, is the same
`API_PARAMETER_INVALID`: the request is wrong, not your onboarding.
`SCA_ORIGIN_NOT_CONFIGURED` (`420064`) means you have no approved origin at
all.

### Replaying an idempotency key rotates the frameToken

`createRegistration` with a key you have used before returns the **same
ceremony** — same `registrationId`, same `expiresAt` — and a **new
`frameToken`** every time.

**The previous token is invalidated.** A replay creates a fresh token because
the previous bearer value cannot be returned. Only the newest token works.

That makes the replay narrower than the word "idempotent" suggests, and in
one direction it is actively unsafe:

> **Once you have handed the token to the page, do not retry this call under
> the same key.** The retry returns `200` with the same `registrationId` and
> reads as a clean replay, while the ceremony your user is part-way through
> stops working. Nothing in the response reports it.

Retrying a call whose response you never received — the case an idempotency
key exists for — is safe. Retrying one whose token you already delivered is
not.

Reusing the key with a different `spcCapable` is `IDEMPOTENCY_KEY_REUSED`
(409) rather than a replay, and omitting that field is the same request as
sending `false` — the service treats an omitted value as `false` before it
looks up the key, so only a true/false disagreement conflicts. A different
`embedOrigin` is the same 409, but omitting it on the replay is not a
conflict: the original ceremony comes back, still bound to the origin it was
opened for. A different `clientEntityId` is the same conflict in principle,
but ownership is verified before the idempotency lookup: one you do not own
returns `CLIENT_ENTITY_NOT_OWNED` (420001) first, and the conflict surfaces
only for an end user you do own.

### There is no "SCA applied" header, and you do not need one

Whether SCA applies to an end user is Circle's determination — it follows the
entity's legal entity, and Circle is the regulated party that has to get it
right. A request Circle did not gate simply succeeds.

This is worth a section only because `X-Sca-Authorization-Id` exists and is
easy to mistake for a confirmation signal. It is not one: Circle stamps it on
the request it proxies _inward_, so the service executing the movement can
record which authorization permitted it, and a copy sent by a caller is
stripped at ingress. It never travels back out, which is why `SCA_HEADERS`
does not name it.

If you believe an entity should be in scope and its transfers are going
through without a ceremony, raise it with Circle.

Five routes have SCA intents — `POST /v1/accounts/transfers`,
`POST /v1/accounts/withdrawals`, `POST /v1/banks/wires`,
`POST /v1/addresses/recipient` and `DELETE /v1/addresses/recipient/{id}` —
The routes that require SCA are determined by Circle. The SDK does not expose
or document rollout state. `intent` on `openChallenge` is the gated route's own
request body, verbatim — `idempotencyKey` included, because it is inside the
signed canonical intent. That key binds the approved intent; it is not a
request-level idempotency key for `openChallenge`. A retry under a new
idempotency key is a different intent and needs a new challenge, so one
approval cannot be replayed across two submissions.

There is no `approve()`-style helper here on purpose: the gated request is
yours, on your own route, with your own client. This SDK does not proxy it.

## Rate limits

The `/v1/accounts/passkeys` group is rate-limited at the gateway, so `429` is a
reachable `DaaApiError`. The response carries Circle's envelope and no
`Retry-After`, which means back-off is your policy to set — one more thing the
injected transport is for.

## mTLS

`/v1/accounts/passkeys` requires a client certificate only when your API key is
configured to require mTLS. Until then a bearer API key over HTTPS is enough
and the default transport works.

Once your key is flagged, a certificate is required. Cloudflare runs _optional_
mTLS by design — it asks for a certificate, accepts either answer, and forwards
whatever it gets — so the edge is not what rejects you. The API gateway is the
sole enforcement point, after key exchange, which is why the failure is a `403`
from the API rather than a TLS handshake error.

Node's global `fetch` cannot be given a certificate, so rather than take a
dependency for a case most callers do not have, supply a transport:

```ts
import { Agent } from 'undici'

const agent = new Agent({ connect: { cert, key } })

const daa = createDaaClient({
  environment,
  apiKey,
  transport: async ({ method, url, headers, body }) => {
    const res = await fetch(url, { method, headers, body, dispatcher: agent })
    return { status: res.status, body: await res.text() }
  },
})
```

The same seam makes every test in this package run without a network. A custom
transport keeps the caller's timeout and observability policy; the default
fetch transport uses `timeoutMs` (30 seconds by default). Retry behavior is
route-specific, and this SDK does not retry requests automatically.
The custom transport receives the entity API key in `headers.authorization`;
do not log request headers or include them in transport errors.

## Responses are wrapped

Every successful Circle response carries its payload under `data`:

```json
{ "data": { "registrationId": "…", "expiresAt": "…", "frameToken": "…" } }
```

This SDK unwraps it, so the methods return the payload. **Errors are not
wrapped** — they are flat `{"code": N, "message": "…"}` — which is why
`DaaApiError` reads the body directly. A successful response without `data` is
rejected.

## Errors

|                     | Meaning                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DaaApiError`       | A non-2xx response. Carries `status`, `rawBody`, and `code`/`message` when the body parsed as Circle's error envelope.                                                                                                                |
| `DaaTransportError` | DNS, TLS, timeout, or reset. The request may or may not have been applied; check that method's retry contract before retrying. Only `createRegistration` has a request-level idempotency lookup, and replay rotates its `frameToken`. |

`code` is Circle's **numeric** public error code, not a symbolic status name.
`DAA_ERROR_CODES` gives you named constants for commonly handled codes:

```ts
import { DAA_ERROR_CODES, isDaaApiError } from '@circle-fin/daa-node-sdk'

try {
  await daa.passkeys.complete({ registrationId, attestationResponse })
} catch (error) {
  if (isDaaApiError(error) && error.code === DAA_ERROR_CODES.PASSKEY_REGISTRATION_EXPIRED) {
    // Ten minutes elapsed. Open a new ceremony; nothing was registered.
  }
}
```

It is **not narrowed to a union**: Circle can add a code without this SDK being
republished, and a caller matching on an unknown number is better than one that
cannot see it at all.

`message` alongside it is caller-actionable — "The passkey registration has
expired", not a stack trace. That does not make the complete error safe to log:
`DaaApiError.rawBody` preserves the upstream response verbatim. Apply your
service's normal redaction and retention rules before logging errors.

An auth failure carries the HTTP status as its `code` — `401`, not a
`4200xx` — so do not assume `code` is always in DAA's range.

Two codes outside the SCA block come up before any inside it, and both are in
`DAA_ERROR_CODES`:

| code     | name                      | when                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `420001` | `CLIENT_ENTITY_NOT_OWNED` | the `clientEntityId` is not an end user of your entity. Every route that takes one, which is every route but `complete()` — that one takes a `registrationId` and answers a plain `404` when the registration belongs to another entity. This is what a `clientEntityId` that has not been through account creation returns, so it is the first error a new integration sees. |
| `420034` | `IDEMPOTENCY_KEY_REUSED`  | `createRegistration` with a key already used for a different `spcCapable` or `embedOrigin`, or for a different `clientEntityId` you also own — one you do not own returns `420001` first, because ownership is verified before the idempotency lookup.                                                                                                                        |

Two values are worth handling explicitly. `-1` means the API gateway did not
recognize what the upstream service returned, and the `message` then carries an
`errId` — that identifier is what Circle support needs. `undefined` means the
body carried no numeric `code` at all, which is what a 502 HTML page from an
edge proxy looks like.

`rawBody` is always present for that reason: a body that did not parse is
exactly when you need to see what arrived.

Those two types describe what happened to a request. A **`TypeError`** means no
request was built at all — an invalid `environment` or `baseUrl`, an empty
`apiKey`, an empty `passkeyId`. Those are programming errors, and they are
raised where the mistake is rather than classified alongside a response.

The API key never appears in an error message. There is a test asserting it.

## Do not log the responses

`frameToken` is a capability: holding it grants a read of one pending ceremony.
DAA only persists its SHA-256 for that reason. These are plain objects, so
nothing here can redact them for you — keep them out of logs, and hand the
token to the page over your own authenticated channel.

## Publishing

Publishing to npm under `@circle-fin` is handled by the release workflow;
`private: true` is flipped only in the manifest it packs.
