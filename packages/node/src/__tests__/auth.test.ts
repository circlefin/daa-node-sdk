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

import { beforeEach, describe, expect, it } from 'vitest'

import { AUTH_HEADERS } from '../auth.js'
import { createDaaClient } from '../client.js'
import type { DaaClient } from '../client.js'
import { isDaaApiError } from '../errors.js'
import type { DaaRequest, DaaResponse } from '../transport.js'

const BASE = 'https://api.circle.com'
const KEY = 'test-api-key'
const JWS = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln'
const OTHER_JWS = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ5In0.b3RoZXI'

let sent: DaaRequest[]
let next: DaaResponse
let daa: DaaClient

beforeEach(() => {
  sent = []
  next = { status: 200, body: '{"data":{"ok":true}}' }
  daa = createDaaClient({
    environment: 'production',
    apiKey: KEY,
    transport: (request) => {
      sent.push(request)
      return Promise.resolve(next)
    },
  })
})

describe('auth relay routes', () => {
  it('posts to the public path, without the daa segment', async () => {
    await daa.auth.prepareLogin('{"a":1}')
    await daa.auth.socialSession('{"b":2}')
    await daa.auth.registerDeviceKey('{"c":3}', { registrationFlowAuthorization: JWS })

    expect(sent.map((r) => [r.method, r.url])).toEqual([
      ['POST', `${BASE}/v1/accounts/auth/loginRequests`],
      ['POST', `${BASE}/v1/accounts/auth/sessions`],
      ['POST', `${BASE}/v1/accounts/auth/deviceKeyRegistration`],
    ])
  })

  it('sends the body byte for byte, with no re-serialization', async () => {
    // Odd spacing, key order and a unicode escape: any parse and stringify
    // round trip would change at least one of them, and the proofs on the
    // registration route sign these exact bytes.
    const raw = '{ "z": 1,  "a" : "\\u00e9" }\n'
    await daa.auth.registerDeviceKey(raw, { registrationFlowAuthorization: JWS })
    expect(sent[0]?.body).toBe(raw)
  })

  it('relays both proofs under their documented header names', async () => {
    await daa.auth.registerDeviceKey('{}', {
      registrationFlowAuthorization: JWS,
      deviceAuthorization: OTHER_JWS,
    })
    expect(sent[0]?.headers[AUTH_HEADERS.registrationFlowAuthorization]).toBe(JWS)
    expect(sent[0]?.headers[AUTH_HEADERS.deviceAuthorization]).toBe(OTHER_JWS)
    expect(AUTH_HEADERS).toEqual({
      registrationFlowAuthorization: 'X-Registration-Flow-Authorization',
      deviceAuthorization: 'X-Device-Authorization',
    })
  })

  it('omits the device proof when none is given', async () => {
    await daa.auth.registerDeviceKey('{}', { registrationFlowAuthorization: JWS })
    expect(sent[0]?.headers).not.toHaveProperty(AUTH_HEADERS.deviceAuthorization)
  })

  it('keeps the credential on every relay call', async () => {
    await daa.auth.prepareLogin('{}')
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(sent[0]?.headers['content-type']).toBe('application/json')
  })

  it('returns the status and the response body as it arrived', async () => {
    next = { status: 201, body: '{"data":{"loginRequestId":"l"},"extra":1}' }
    await expect(daa.auth.prepareLogin('{}')).resolves.toEqual({
      status: 201,
      rawBody: '{"data":{"loginRequestId":"l"},"extra":1}',
    })
  })

  it.each([
    ['an empty body', ''],
    ['an unwrapped body', '{"loginRequestId":"l"}'],
    ['a body that is not JSON', '<html>ok</html>'],
    ['a null payload', '{"data":null}'],
  ])('returns a 2xx with %s as received instead of failing it', async (_name, body) => {
    next = { status: 200, body }
    await expect(daa.auth.socialSession('{}')).resolves.toEqual({ status: 200, rawBody: body })
  })

  it('throws DaaApiError for a non-2xx, carrying status and body', async () => {
    next = { status: 409, body: '{"code":420034,"message":"reused"}' }
    const error: unknown = await daa.auth.socialSession('{}').catch((e: unknown) => e)
    expect(isDaaApiError(error)).toBe(true)
    expect(error).toMatchObject({ status: 409, code: 420034, rawBody: next.body })
  })

  it('rejects an empty body before sending', async () => {
    await expect(daa.auth.prepareLogin('')).rejects.toThrow(/rawBody/)
    expect(sent).toHaveLength(0)
  })

  it.each([
    ['empty', ''],
    ['two segments', 'a.b'],
    ['whitespace', 'a.b.c d'],
    ['a line break', 'a.b.c\r\nX-Injected: 1'],
  ])('rejects a registration proof that is %s', async (_name, value) => {
    await expect(
      daa.auth.registerDeviceKey('{}', { registrationFlowAuthorization: value }),
    ).rejects.toThrow(/registrationFlowAuthorization/)
    await expect(
      daa.auth.registerDeviceKey('{}', {
        registrationFlowAuthorization: JWS,
        deviceAuthorization: value,
      }),
    ).rejects.toThrow(/deviceAuthorization/)
    expect(sent).toHaveLength(0)
  })
})

describe('openChallenge schemaVersion', () => {
  it('is sent when set and absent when not', async () => {
    next = {
      status: 200,
      body: '{"data":{"challengeId":"x","expiresAt":"t","summary":{},"frameToken":"f"}}',
    }
    await daa.passkeys.openChallenge({
      clientEntityId: 'c',
      operation: 'CREATE_ACCOUNT',
      intent: {},
      schemaVersion: 1,
    })
    await daa.passkeys.openChallenge({ clientEntityId: 'c', operation: 'TRANSFER', intent: {} })
    expect(JSON.parse(sent[0]?.body ?? '')).toMatchObject({ schemaVersion: 1 })
    expect(JSON.parse(sent[1]?.body ?? '')).not.toHaveProperty('schemaVersion')
  })
})
