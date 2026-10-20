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

import { describe, expect, it } from 'vitest'

import { resolveBaseUrl } from '../config.js'

const base = { environment: 'sandbox', apiKey: 'test-key' } as const

describe('resolveBaseUrl', () => {
  it('accepts an https Circle origin by default', () => {
    expect(resolveBaseUrl({ ...base, baseUrl: 'https://api.circle.com' })).toBe(
      'https://api.circle.com',
    )
  })

  it('rejects a non-Circle host without the override', () => {
    expect(() => resolveBaseUrl({ ...base, baseUrl: 'https://example.com' })).toThrow(
      /not a Circle host/,
    )
  })

  it('accepts http on any loopback host with the override', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(
        resolveBaseUrl({ ...base, baseUrl: origin, allowNonCircleBaseUrl: true }),
      ).toBe(new URL(origin).origin)
    }
  })

  it('rejects http on a non-loopback host even with the override', () => {
    expect(() =>
      resolveBaseUrl({ ...base, baseUrl: 'http://example.com', allowNonCircleBaseUrl: true }),
    ).toThrow(/must be https/)
  })
})
