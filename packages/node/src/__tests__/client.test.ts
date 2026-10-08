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

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDaaClient } from '../client.js'
import type { DaaClient } from '../client.js'
import { DAA_ENVIRONMENTS } from '../config.js'
import type { DaaEnvironment } from '../config.js'
import { DAA_ERROR_CODES, isDaaApiError } from '../errors.js'
import { SCA_HEADERS } from '../passkeys.js'
import type { DaaRequest, DaaResponse, DaaTransport } from '../transport.js'

const BASE = 'https://api.circle.com'
const KEY = 'test-api-key'

interface Recorder {
  readonly sent: DaaRequest[]
  transport: DaaTransport
  /** `body` is wrapped in the `data` envelope; `rawBody` is sent verbatim. */
  reply(response: Partial<DaaResponse> & { rawBody?: string }): void
}

const recorder = (): Recorder => {
  const sent: DaaRequest[] = []
  let next: DaaResponse = { status: 200, body: '{}' }
  return {
    sent,
    transport: (request) => {
      sent.push(request)
      return Promise.resolve(next)
    },
    /**
     * `body` is the payload, and the recorder wraps it in the `data` envelope
     * the real API returns — `{"data": {...}}`. Verified against a Circle
     * test environment: every success response is wrapped, errors are not.
     *
     * Wrapped here rather than at each call site on purpose. These bodies used
     * to be written unwrapped, which is how forty passing tests coexisted with
     * a client that never unwrapped anything: the fake agreed with the bug.
     * Putting the envelope in one place means a test cannot opt out of it by
     * accident. Use `rawBody` for the cases that are *about* a malformed
     * envelope.
     */
    reply(response) {
      const body =
        response.rawBody ??
        (response.body === undefined ? '' : JSON.stringify({ data: JSON.parse(response.body) }))
      next = { status: response.status ?? 200, body }
    },
  }
}

let rec: Recorder
let daa: DaaClient

beforeEach(() => {
  rec = recorder()
  daa = createDaaClient({ environment: 'production', apiKey: KEY, transport: rec.transport })
})

describe('routes', () => {
  it('uses the public path, without the daa segment', async () => {
    // /v1/daa/... is DAA's own service path and is not what a
    // distributor calls. The API gateway exposes this group. Getting it wrong is a 404 that
    // reads as a missing feature.
    rec.reply({ body: JSON.stringify({ registrationId: 'r', expiresAt: 't', frameToken: 'f' }) })
    await daa.passkeys.createRegistration({ clientEntityId: 'c', idempotencyKey: 'i' })
    expect(rec.sent[0]?.url).toBe('https://api.circle.com/v1/accounts/passkeys/registrations')
    expect(rec.sent[0]?.url).not.toContain('/daa/')
  })

  it('maps each call to its documented method and path', async () => {
    rec.reply({ body: JSON.stringify({ passkeys: [] }) })
    await daa.passkeys.list({ clientEntityId: 'c' })

    rec.reply({ body: JSON.stringify({ passkeyId: 'p', credentialId: 'c' }) })
    await daa.passkeys.complete({ registrationId: 'r', attestationResponse: {} })

    rec.reply({ status: 204 })
    await daa.passkeys.revoke('pk-1', { clientEntityId: 'c' })

    rec.reply({
      body: JSON.stringify({ challengeId: 'x', expiresAt: 't', summary: {}, frameToken: 'f' }),
    })
    await daa.passkeys.openChallenge({ clientEntityId: 'c', operation: 'TRANSFER', intent: {} })

    expect(rec.sent.map((r) => `${r.method} ${r.url.replace(BASE, '')}`)).toEqual([
      'GET /v1/accounts/passkeys?clientEntityId=c',
      'POST /v1/accounts/passkeys',
      'DELETE /v1/accounts/passkeys/pk-1?clientEntityId=c',
      'POST /v1/accounts/passkeys/challenges',
    ])
  })

  it('sends the open-challenge body as exactly the five documented members', async () => {
    // DAA's `OpenScaChallengeRequest` is the one request record in this API
    // declared `@JsonIgnoreProperties(ignoreUnknown = false)`, so a sixth
    // member is a 400 rather than something it drops. `toEqual`, not
    // `toMatchObject`: what needs pinning is that nothing extra goes out.
    rec.reply({
      body: JSON.stringify({ challengeId: 'x', expiresAt: 't', summary: {}, frameToken: 'f' }),
    })
    await daa.passkeys.openChallenge({
      clientEntityId: 'c',
      operation: 'ADDRESS_BOOK_DELETE',
      intent: {},
      pathParameters: { id: '9a95b5a6-99b9-50d9-b9b2-8d1a852b5538' },
      ceremonyKind: 'webauthn',
    })
    expect(JSON.parse(rec.sent[0]?.body ?? '{}')).toEqual({
      clientEntityId: 'c',
      operation: 'ADDRESS_BOOK_DELETE',
      intent: {},
      pathParameters: { id: '9a95b5a6-99b9-50d9-b9b2-8d1a852b5538' },
      ceremonyKind: 'webauthn',
    })
  })

  it('sends embedOrigin as given on both ceremony opens', async () => {
    // DAA exact-matches it against the distributor's approved origins, so the
    // SDK must not normalize it — a trailing slash added here would be a 400.
    rec.reply({ body: JSON.stringify({ registrationId: 'r', expiresAt: 't', frameToken: 'f' }) })
    await daa.passkeys.createRegistration({
      clientEntityId: 'c',
      idempotencyKey: 'i',
      embedOrigin: 'https://app.example.com',
    })
    rec.reply({
      body: JSON.stringify({ challengeId: 'x', expiresAt: 't', summary: {}, frameToken: 'f' }),
    })
    await daa.passkeys.openChallenge({
      clientEntityId: 'c',
      operation: 'TRANSFER',
      intent: {},
      embedOrigin: 'https://app.example.com',
    })

    expect(JSON.parse(rec.sent[0]?.body ?? '{}')).toEqual({
      clientEntityId: 'c',
      idempotencyKey: 'i',
      embedOrigin: 'https://app.example.com',
    })
    expect(JSON.parse(rec.sent[1]?.body ?? '{}')).toEqual({
      clientEntityId: 'c',
      operation: 'TRANSFER',
      intent: {},
      embedOrigin: 'https://app.example.com',
    })
  })

  it('omits pathParameters entirely for a bodied operation', async () => {
    // Not the same as sending `{}`: DAA defaults the field, and a caller who
    // has to pass an empty map to open an ordinary transfer challenge would
    // read that as the field being required.
    rec.reply({
      body: JSON.stringify({ challengeId: 'x', expiresAt: 't', summary: {}, frameToken: 'f' }),
    })
    await daa.passkeys.openChallenge({
      clientEntityId: 'c',
      operation: 'TRANSFER',
      intent: { idempotencyKey: 'i' },
    })
    expect(JSON.parse(rec.sent[0]?.body ?? '{}')).toEqual({
      clientEntityId: 'c',
      operation: 'TRANSFER',
      intent: { idempotencyKey: 'i' },
    })
  })

  it('rejects a passkeyId that is not an opaque path-safe identifier', async () => {
    await expect(daa.passkeys.revoke('../sca/check', { clientEntityId: 'c' })).rejects.toThrow(
      /passkeyId must be 1–128 letters, digits, underscores, or hyphens/,
    )
    expect(rec.sent).toHaveLength(0)
  })
})

describe('auth and headers', () => {
  it('sends the api key as a bearer token', async () => {
    rec.reply({ body: JSON.stringify({ passkeys: [] }) })
    await daa.passkeys.list({ clientEntityId: 'c' })
    expect(rec.sent[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('sets content-type only when there is a body', async () => {
    rec.reply({ body: JSON.stringify({ passkeys: [] }) })
    await daa.passkeys.list({ clientEntityId: 'c' })
    expect(rec.sent[0]?.headers).not.toHaveProperty('content-type')

    rec.reply({ body: JSON.stringify({ registrationId: 'r', expiresAt: 't', frameToken: 'f' }) })
    await daa.passkeys.createRegistration({ clientEntityId: 'c', idempotencyKey: 'i' })
    expect(rec.sent[1]?.headers['content-type']).toBe('application/json')
  })
})

describe('attestation relay', () => {
  it('serializes the attestation exactly once, without reshaping it', async () => {
    // Re-serializing the nested response invalidates the signature over
    // clientDataJSON, so the object the browser produced has to survive
    // untouched.
    const attestationResponse = {
      id: 'cred',
      rawId: 'cred',
      type: 'public-key',
      response: {
        clientDataJSON: 'eyJ0IjoxfQ',
        attestationObject: 'o2Nmb',
        transports: ['internal'],
      },
    }
    rec.reply({ body: JSON.stringify({ passkeyId: 'p', credentialId: 'c' }) })
    await daa.passkeys.complete({ registrationId: 'r', attestationResponse })

    const body: unknown = JSON.parse(rec.sent[0]?.body ?? 'null')
    expect((body as { attestationResponse: unknown }).attestationResponse).toEqual(
      attestationResponse,
    )
  })
})

describe('errors', () => {
  it("reads Circle's error envelope, whose code is a number", async () => {
    // `{"code": 420054, "message": "..."}` — flat, and numeric. The string
    // `SCA_CHALLENGE_EXPIRED` is a server-side name only; the API gateway
    // translates it on the way out, so it never reaches a distributor.
    rec.reply({
      status: 410,
      rawBody: JSON.stringify({ code: DAA_ERROR_CODES.SCA_CHALLENGE_EXPIRED, message: 'expired' }),
    })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      status: 410,
      code: 420054,
      message: 'expired',
    })
  })

  it('surfaces the generic -1 envelope with its errId intact', async () => {
    // -1 is the API gateway's fallback when it did not recognize what the upstream
    // service returned. The errId in the message is what Circle support needs,
    // so it must survive in both `message` and `rawBody`.
    const body = JSON.stringify({ code: -1, message: 'Something went wrong. errId: abc-123' })
    rec.reply({ status: 500, rawBody: body })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      code: -1,
      message: expect.stringContaining('errId: abc-123') as unknown as string,
      rawBody: body,
    })
  })

  it('names the two codes outside the SCA block that these routes return', async () => {
    // Both observed against a Circle test environment. `CLIENT_ENTITY_NOT_OWNED` is what
    // an end user with no parent-entity mapping returns — from the four routes that
    // verify ownership, which is every one except `complete()`; that one
    // filters on the parent entity and answers 404 with
    // `PASSKEY_REGISTRATION_NOT_FOUND` (420065).
    // It is still the first thing a new integration gets wrong.
    //
    // `IDEMPOTENCY_KEY_REUSED` comes back from createRegistration when a key
    // is replayed with a different `spcCapable`. A different `clientEntityId`
    // conflicts in principle but you will usually see `CLIENT_ENTITY_NOT_OWNED`
    // instead, because ownership is verified before the idempotency lookup —
    // measured, 400/420001 rather than 409/420034.
    //
    // Neither is in 420046–420063, so a table that only covered that block
    // left a caller matching on raw numbers for the two errors they hit first.
    expect(DAA_ERROR_CODES.CLIENT_ENTITY_NOT_OWNED).toBe(420001)
    expect(DAA_ERROR_CODES.IDEMPOTENCY_KEY_REUSED).toBe(420034)
    expect(DAA_ERROR_CODES.SCA_ORIGIN_NOT_CONFIGURED).toBe(420064)
    expect(DAA_ERROR_CODES.PASSKEY_REGISTRATION_NOT_FOUND).toBe(420065)
    expect(DAA_ERROR_CODES.SCA_INTENT_LOCATION_TYPE_UNSUPPORTED).toBe(420066)
    expect(DAA_ERROR_CODES.REQUEST_BODY_TOO_LARGE).toBe(420067)

    rec.reply({
      status: 400,
      rawBody: '{"code":420001,"message":"The clientEntityId is not valid for this entity"}',
    })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      code: DAA_ERROR_CODES.CLIENT_ENTITY_NOT_OWNED,
    })
  })

  it('does not narrow the code, so a newly added Circle code is still visible', async () => {
    rec.reply({ status: 409, rawBody: JSON.stringify({ code: 420099 }) })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      code: 420099,
    })
  })

  it('keeps a JSON body that is not an envelope', async () => {
    // Valid JSON, no numeric `code`. Distinct from the non-JSON case: the
    // tolerant read has to leave `code`/`message` unset rather than coerce
    // whatever it found.
    rec.reply({ status: 400, rawBody: JSON.stringify({ detail: 'something else' }) })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      status: 400,
      code: undefined,
      message: 'DAA API responded 400',
      rawBody: '{"detail":"something else"}',
    })
  })

  it('keeps a non-JSON body rather than failing to parse it', async () => {
    // A 502 from an edge proxy is an HTML page, and that is exactly when the
    // caller needs to see what arrived.
    rec.reply({ status: 502, rawBody: '<html>Bad Gateway</html>' })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      status: 502,
      rawBody: '<html>Bad Gateway</html>',
      code: undefined,
    })
  })

  it('never puts the api key in an error', async () => {
    rec.reply({ status: 403, rawBody: JSON.stringify({ code: 420048, message: 'not found' }) })
    try {
      await daa.passkeys.list({ clientEntityId: 'c' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(isDaaApiError(error)).toBe(true)
      expect(
        JSON.stringify({ m: (error as Error).message, r: (error as { rawBody: string }).rawBody }),
      ).not.toContain(KEY)
    }
  })

  it('keeps a malformed success body inside the two error types', async () => {
    // The README sells exactly two error types. A 2xx whose body does not
    // parse used to throw a raw SyntaxError straight through `JSON.parse`,
    // which a caller branching on isDaaApiError/isDaaTransportError cannot
    // classify at all.
    rec.reply({ status: 200, rawBody: '{"passkeys":' })
    try {
      await daa.passkeys.list({ clientEntityId: 'c' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(isDaaApiError(error)).toBe(true)
      expect((error as { status: number }).status).toBe(200)
      expect((error as { rawBody: string }).rawBody).toBe('{"passkeys":')
      expect((error as Error).message).toContain('not JSON')
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError)
    }
  })

  it('treats an empty body on a route that must return one as an error', async () => {
    rec.reply({ status: 200, rawBody: '' })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      message: expect.stringContaining('empty body') as unknown as string,
    })
  })

  it('reports the status it actually got when a required body is empty', async () => {
    // Not a hardcoded 200: an error that misreports the status it was raised
    // from sends the reader looking at the wrong response.
    rec.reply({ status: 204, rawBody: '' })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      status: 204,
    })
  })

  it('accepts an empty body on revoke, which returns 204', async () => {
    rec.reply({ status: 204, rawBody: '' })
    await expect(daa.passkeys.revoke('pk-1', { clientEntityId: 'c' })).resolves.toBeUndefined()
  })
})

describe('the data envelope', () => {
  it('unwraps data, so the payload is the payload', async () => {
    // Captured from a Circle test environment: every success response is wrapped.
    rec.reply({ rawBody: '{"data":{"registrationId":"r-1","expiresAt":"t","frameToken":"f-1"}}' })
    const reg = await daa.passkeys.createRegistration({ clientEntityId: 'c', idempotencyKey: 'i' })

    // Before the unwrap these were all `undefined` while the type said
    // otherwise, so the flow died at "hand frameToken to the page".
    expect(reg).toEqual({ registrationId: 'r-1', expiresAt: 't', frameToken: 'f-1' })
  })

  it('rejects a 2xx body with no data envelope rather than reading past it', async () => {
    // The shape of the original bug: an unwrapped body. Accepting it would
    // let the mistake back in, and silently — the fields would just be
    // missing.
    rec.reply({ rawBody: '{"registrationId":"r-1","frameToken":"f-1"}' })
    await expect(
      daa.passkeys.createRegistration({ clientEntityId: 'c', idempotencyKey: 'i' }),
    ).rejects.toMatchObject({
      status: 200,
      message: expect.stringContaining('"data" payload') as unknown as string,
    })
  })

  it('never returns undefined from list(), whatever the envelope contains', async () => {
    // This is what actually broke: `list()` promised an array and returned
    // `undefined`, so the TypeError surfaced at the caller's `.length`,
    // nowhere near the response that caused it.
    rec.reply({ rawBody: '{"data":{}}' })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      message: expect.stringContaining('passkeys') as unknown as string,
    })
  })

  it('reads the real response for an end user with no passkeys', async () => {
    // Byte-for-byte what a Circle test environment returned.
    rec.reply({ rawBody: '{"data":{"passkeys":[]}}' })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).resolves.toEqual([])
  })

  it('returns the SCA requirement with the passkeys from status()', async () => {
    rec.reply({ rawBody: '{"data":{"sca":{"required":true},"passkeys":[{"passkeyId":"p-1"}]}}' })
    await expect(daa.passkeys.status({ clientEntityId: 'c' })).resolves.toEqual({
      sca: { required: true },
      passkeys: [{ passkeyId: 'p-1' }],
    })
    rec.reply({ rawBody: '{"data":{"sca":{"required":false},"passkeys":[]}}' })
    await expect(daa.passkeys.status({ clientEntityId: 'c' })).resolves.toEqual({
      sca: { required: false },
      passkeys: [],
    })
    // The same GET as list(), not a route of its own.
    expect(rec.sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET https://api.circle.com/v1/accounts/passkeys?clientEntityId=c',
      'GET https://api.circle.com/v1/accounts/passkeys?clientEntityId=c',
    ])
  })

  it('reads an absent, null or malformed sca as unknown, never as "not required"', async () => {
    for (const sca of [
      '',
      ',"sca":null',
      ',"sca":{}',
      ',"sca":{"required":"true"}',
      ',"sca":[true]',
    ]) {
      rec.reply({ rawBody: `{"data":{"passkeys":[]${sca}}}` })
      await expect(daa.passkeys.status({ clientEntityId: 'c' })).resolves.toEqual({
        sca: null,
        passkeys: [],
      })
    }
  })

  it('holds status() to the same passkeys check as list()', async () => {
    rec.reply({ rawBody: '{"data":{"sca":{"required":true}}}' })
    await expect(daa.passkeys.status({ clientEntityId: 'c' })).rejects.toMatchObject({
      message: expect.stringContaining('passkeys') as unknown as string,
    })
  })

  it('refuses {"data": null} rather than returning it as the payload', async () => {
    // `'data' in parsed` is true here, so the first version of this check let
    // it through — and `list()` then read `.passkeys` off `null`, which is the
    // raw TypeError this whole PR exists to remove. The key being present is
    // not the same as the payload being there.
    rec.reply({ rawBody: '{"data":null}' })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      status: 200,
      message: expect.stringContaining('"data" payload') as unknown as string,
    })

    // `data` present and non-null, but the array inside it is null. A
    // different path — past the envelope check, into `list()`'s own guard —
    // and the one the first draft of this test missed by looping over the
    // same string twice.
    rec.reply({ rawBody: '{"data":{"passkeys":null}}' })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      message: expect.stringContaining('passkeys') as unknown as string,
    })

    rec.reply({ rawBody: '{"data":null}' })
    await expect(
      daa.passkeys.createRegistration({ clientEntityId: 'c', idempotencyKey: 'i' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('"data" payload') as unknown as string,
    })
  })

  it('unwraps for complete and openChallenge too, not only the two tested above', async () => {
    rec.reply({ rawBody: '{"data":{"passkeyId":"p-1","credentialId":"c-1"}}' })
    await expect(
      daa.passkeys.complete({ registrationId: 'r', attestationResponse: {} }),
    ).resolves.toEqual({ passkeyId: 'p-1', credentialId: 'c-1' })

    rec.reply({
      rawBody: '{"data":{"challengeId":"ch-1","expiresAt":"t","summary":{},"frameToken":"f-1"}}',
    })
    await expect(
      daa.passkeys.openChallenge({ clientEntityId: 'c', operation: 'TRANSFER', intent: {} }),
    ).resolves.toEqual({ challengeId: 'ch-1', expiresAt: 't', summary: {}, frameToken: 'f-1' })
  })

  it('quotes the response it actually got when the passkeys array is missing', async () => {
    // Not a reconstructed body and not a hardcoded 200 — both would point the
    // reader at something the server never sent.
    rec.reply({ status: 299, rawBody: '{"data":{"unexpected":true}}' })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      status: 299,
      rawBody: '{"data":{"unexpected":true}}',
    })
  })

  it('leaves error envelopes unwrapped, because the API does', async () => {
    // Verified live: errors are flat `{"code":N,"message":"..."}`, not
    // wrapped. Reading `data` off them would lose every code.
    rec.reply({
      status: 400,
      rawBody: '{"code":420001,"message":"The clientEntityId is not valid for this entity"}',
    })
    await expect(daa.passkeys.list({ clientEntityId: 'c' })).rejects.toMatchObject({
      status: 400,
      code: 420001,
      message: 'The clientEntityId is not valid for this entity',
    })
  })
})

describe('step-up headers', () => {
  it('names the three headers of the round trip', () => {
    // Pinned because they are strings a caller types by hand — this SDK does
    // not send any of them. A typo in the first two reads as "SCA was not
    // required" rather than as a bad header.
    expect(SCA_HEADERS).toEqual({
      challengeId: 'X-Sca-Challenge-Id',
      assertion: 'X-Sca-Assertion',
    })
  })

  it('does not name X-Sca-Authorization-Id, which a caller never sees', () => {
    // It is stamped on the request the API gateway proxies *inward*, and a copy
    // sent by a caller is stripped at ingress. Exporting its name would
    // invite someone to look for it on a response it never reaches, which is
    // exactly the mistake the docstring above it exists to prevent.
    expect(Object.values(SCA_HEADERS)).not.toContain('X-Sca-Authorization-Id')
  })

  it('does not send them itself', async () => {
    // The gated request is the caller's, on their own route. If this package
    // ever started sending these, it would mean it had grown a proxy for
    // money movement, which is not what it is.
    rec.reply({
      body: JSON.stringify({ challengeId: 'c', expiresAt: 't', summary: {}, frameToken: 'f' }),
    })
    await daa.passkeys.openChallenge({ clientEntityId: 'c', operation: 'TRANSFER', intent: {} })

    const sent = Object.keys(rec.sent[0]?.headers ?? {}).map((h) => h.toLowerCase())
    for (const header of Object.values(SCA_HEADERS)) {
      expect(sent).not.toContain(header.toLowerCase())
    }
  })
})

describe('environments', () => {
  it('selects the documented API origin for each environment', async () => {
    // Paired with the ceremony origin the web SDK selects for the same
    // environment, so two SDKs given the same `environment` cannot end up
    // pointed at two different deployments.
    const expected: Readonly<Record<DaaEnvironment, string>> = {
      sandbox: 'https://api-sandbox.circle.com',
      production: 'https://api.circle.com',
    }

    for (const environment of DAA_ENVIRONMENTS) {
      const rec2 = recorder()
      rec2.reply({ body: JSON.stringify({ passkeys: [] }) })
      const client = createDaaClient({ environment, apiKey: KEY, transport: rec2.transport })
      await client.passkeys.list({ clientEntityId: 'c' })
      expect(rec2.sent[0]?.url).toBe(
        `${expected[environment]}/v1/accounts/passkeys?clientEntityId=c`,
      )
    }
  })

  it('selects the EU-residency origin when the key is eu_restricted', async () => {
    // Not an alias. The API gateway rejects an eu_restricted principal on any host
    // outside its allowlist, fail-closed, on every authenticated request — so
    // the wrong host here is a blanket 403, not a passkey error.
    const expected: Readonly<Record<DaaEnvironment, string>> = {
      sandbox: 'https://api-sandbox-eu.circle.com',
      production: 'https://api-eu.circle.com',
    }

    for (const environment of DAA_ENVIRONMENTS) {
      const rec2 = recorder()
      rec2.reply({ body: JSON.stringify({ passkeys: [] }) })
      const client = createDaaClient({
        environment,
        euRestricted: true,
        apiKey: KEY,
        transport: rec2.transport,
      })
      await client.passkeys.list({ clientEntityId: 'c' })
      expect(rec2.sent[0]?.url).toBe(
        `${expected[environment]}/v1/accounts/passkeys?clientEntityId=c`,
      )
    }
  })

  it('treats euRestricted: false the same as omitting it', async () => {
    // A key that is not eu_restricted is accepted on either host, so this must
    // not become a third state.
    const client = createDaaClient({
      environment: 'production',
      euRestricted: false,
      apiKey: KEY,
      transport: rec.transport,
    })
    rec.reply({ body: JSON.stringify({ passkeys: [] }) })
    await client.passkeys.list({ clientEntityId: 'c' })
    expect(rec.sent[0]?.url).toContain('https://api.circle.com/')
  })

  it('lets baseUrl win over euRestricted', async () => {
    const client = createDaaClient({
      environment: 'production',
      euRestricted: true,
      baseUrl: 'https://api-test.circle.com',
      apiKey: KEY,
      transport: rec.transport,
    })
    rec.reply({ body: JSON.stringify({ passkeys: [] }) })
    await client.passkeys.list({ clientEntityId: 'c' })
    expect(rec.sent[0]?.url).toContain('https://api-test.circle.com/')
  })

  it('rejects an environment outside the allow-list at construction', () => {
    // The compile-time type cannot catch a JavaScript caller, and an unknown
    // environment would otherwise mean requests to a host that does not exist.
    expect(() =>
      createDaaClient({
        environment: 'prod' as DaaEnvironment,
        apiKey: KEY,
        transport: rec.transport,
      }),
    ).toThrow(/environment must be one of sandbox, production/)
  })

  it('exposes only sandbox and production, with or without a baseUrl', () => {
    // Only the public environments are names. Anything else is reached through
    // `baseUrl`, and the override does not make an unknown name acceptable.
    expect(DAA_ENVIRONMENTS).toEqual(['sandbox', 'production'])
    for (const environment of ['development', 'test']) {
      const env = environment as DaaEnvironment
      expect(() =>
        createDaaClient({ environment: env, apiKey: KEY, transport: rec.transport }),
      ).toThrow(/environment must be one of/)
      expect(() =>
        createDaaClient({
          environment: env,
          baseUrl: 'https://api-test.circle.com',
          apiKey: KEY,
          transport: rec.transport,
        }),
      ).toThrow(/environment must be one of/)
    }
  })

  it('reaches another Circle host through sandbox and baseUrl', async () => {
    // How Circle's own testing targets a host outside the public set.
    const client = createDaaClient({
      environment: 'sandbox',
      baseUrl: 'https://api-test.circle.com',
      apiKey: KEY,
      transport: rec.transport,
    })
    rec.reply({ body: JSON.stringify({ passkeys: [] }) })
    await client.passkeys.list({ clientEntityId: 'c' })
    expect(rec.sent[0]?.url).toBe(
      'https://api-test.circle.com/v1/accounts/passkeys?clientEntityId=c',
    )
  })

  it('lets baseUrl override the environment, for the regional edge', () => {
    const client = createDaaClient({
      environment: 'production',
      baseUrl: 'https://api-eu.circle.com',
      apiKey: KEY,
      transport: rec.transport,
    })
    rec.reply({ body: JSON.stringify({ passkeys: [] }) })
    return client.passkeys.list({ clientEntityId: 'c' }).then(() => {
      expect(rec.sent[0]?.url).toContain('https://api-eu.circle.com/')
    })
  })
})

describe('config validation', () => {
  it('rejects a base url with a path, and a non-https one', () => {
    const t = rec.transport
    expect(() =>
      createDaaClient({
        environment: 'production',
        baseUrl: `${BASE}/v1`,
        apiKey: KEY,
        transport: t,
      }),
    ).toThrow(/bare origin/)
    expect(() =>
      createDaaClient({
        environment: 'production',
        baseUrl: 'http://api.circle.com',
        apiKey: KEY,
        transport: t,
      }),
    ).toThrow(/https/)
    expect(() =>
      createDaaClient({
        environment: 'production',
        baseUrl: 'not a url',
        apiKey: KEY,
        transport: t,
      }),
    ).toThrow(/valid URL/)
  })

  it('rejects a non-Circle host by default', () => {
    const t = rec.transport
    expect(() =>
      createDaaClient({
        environment: 'production',
        baseUrl: 'https://evil.example',
        apiKey: KEY,
        transport: t,
      }),
    ).toThrow(/not a Circle host/)
  })

  it('accepts a genuine non-Circle https origin with the explicit opt-in', () => {
    const t = rec.transport
    expect(() =>
      createDaaClient({
        environment: 'production',
        baseUrl: 'https://partner.example',
        allowNonCircleBaseUrl: true,
        apiKey: KEY,
        transport: t,
      }),
    ).not.toThrow()
  })

  it('accepts a trailing slash and explicitly opted-in http on localhost', () => {
    const t = rec.transport
    expect(() =>
      createDaaClient({
        environment: 'production',
        baseUrl: `${BASE}/`,
        apiKey: KEY,
        transport: t,
      }),
    ).not.toThrow()
    expect(() =>
      createDaaClient({
        environment: 'production',
        baseUrl: 'http://localhost:3000',
        allowNonCircleBaseUrl: true,
        apiKey: KEY,
        transport: t,
      }),
    ).not.toThrow()
  })

  it('rejects a non-http scheme on localhost too', () => {
    // The check used to be `protocol !== 'https:' && hostname !== 'localhost'`,
    // which accepts any scheme at all as long as the host is literally
    // localhost — a weaker guarantee than the message it throws.
    const t = rec.transport
    expect(() =>
      createDaaClient({
        environment: 'production',
        baseUrl: 'ftp://localhost',
        allowNonCircleBaseUrl: true,
        apiKey: KEY,
        transport: t,
      }),
    ).toThrow(/https/)
  })

  it('accepts a validly-cased origin the URL parser normalizes', () => {
    // `https://API.circle.com` has no path, query or fragment; comparing the
    // parser's lowercased origin against the raw string rejected it with an
    // error about being a bare origin, which it is.
    const t = rec.transport
    expect(() =>
      createDaaClient({
        environment: 'production',
        baseUrl: 'https://API.circle.com',
        apiKey: KEY,
        transport: t,
      }),
    ).not.toThrow()
  })

  it('rejects credentials embedded in the base url', () => {
    const t = rec.transport
    expect(() =>
      createDaaClient({
        environment: 'production',
        baseUrl: 'https://user:pw@api.circle.com',
        apiKey: KEY,
        transport: t,
      }),
    ).toThrow(/credentials/)
  })

  it('rejects timeoutMs values outside the supported timer range', () => {
    for (const timeoutMs of [0, Number.NaN, 1.5, 2_147_483_648]) {
      expect(() => createDaaClient({ environment: 'production', apiKey: KEY, timeoutMs })).toThrow(
        /timeoutMs must be an integer from 1 to 2147483647 milliseconds/,
      )
    }
    expect(() =>
      createDaaClient({ environment: 'production', apiKey: KEY, timeoutMs: 2_147_483_647 }),
    ).not.toThrow()
  })

  it('does not validate timeoutMs when a custom transport is supplied', () => {
    // A custom transport owns its own timeout policy per the `timeoutMs` doc
    // comment, so an out-of-range value it will never see must not fail
    // construction.
    const t = rec.transport
    expect(() =>
      createDaaClient({
        environment: 'production',
        apiKey: KEY,
        timeoutMs: -1,
        transport: t,
      }),
    ).not.toThrow()
  })

  it('falls back to the default fetch transport when none is supplied', async () => {
    // The documented default, and nothing else asserted it — every other test
    // injects a transport, which is what the seam is for.
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url)
      // The real API's envelope: this test bypasses the recorder, so it
      // has to supply it itself.
      return Promise.resolve(new Response('{"data":{"passkeys":[]}}', { status: 200 }))
    })
    try {
      const client = createDaaClient({ environment: 'sandbox', apiKey: KEY })
      await client.passkeys.list({ clientEntityId: 'c' })
      expect(calls).toEqual([
        'https://api-sandbox.circle.com/v1/accounts/passkeys?clientEntityId=c',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects an empty passkeyId at the call site', async () => {
    // A `TypeError`, not a `DaaApiError`: an empty id is a programming error,
    // caught before a request is built, and the same thing `createDaaClient`
    // does for an empty `apiKey`. The two documented error types describe what
    // happened to a request that was actually sent.
    await expect(daa.passkeys.revoke('', { clientEntityId: 'c' })).rejects.toThrow(TypeError)
    await expect(daa.passkeys.revoke('', { clientEntityId: 'c' })).rejects.toThrow(/passkeyId/)
    expect(rec.sent).toHaveLength(0)
  })

  it('rejects an empty api key at construction', () => {
    expect(() =>
      createDaaClient({ environment: 'production', apiKey: '', transport: rec.transport }),
    ).toThrow(/apiKey/)
  })
})
