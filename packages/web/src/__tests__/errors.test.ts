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

import { isScaError, ScaError } from '../errors.js'

describe('ScaError', () => {
  it('carries a machine-readable code alongside the message', () => {
    const error = new ScaError('Expired', 'the ceremony expired')
    expect(error.code).toBe('Expired')
    expect(error.message).toBe('the ceremony expired')
    expect(error.name).toBe('ScaError')
  })

  it('is a real Error, so it survives throw/catch and instanceof', () => {
    try {
      throw new ScaError('Cancelled', 'dismissed')
    } catch (caught) {
      expect(caught).toBeInstanceOf(Error)
      expect(caught).toBeInstanceOf(ScaError)
    }
  })

  it('preserves an underlying cause for diagnosis', () => {
    const root = new TypeError('container is not an element')
    const error = new ScaError('Unsupported', 'could not mount', { cause: root })
    expect(error.cause).toBe(root)
  })

  it('narrows with isScaError without matching a plain Error', () => {
    expect(isScaError(new ScaError('Transport', 'x'))).toBe(true)
    expect(isScaError(new Error('x'))).toBe(false)
    expect(isScaError({ code: 'Transport', message: 'x' })).toBe(false)
    expect(isScaError(undefined)).toBe(false)
  })

  it('keeps Cancelled and Unsupported as separate codes', () => {
    // Several platforms collapse both into a generic "not allowed". One means
    // "offer a retry", the other means "take the fallback path", so a consumer
    // must be able to tell them apart.
    const cancelled = new ScaError('Cancelled', 'user dismissed')
    const unsupported = new ScaError('Unsupported', 'no authenticator')
    expect(cancelled.code).not.toBe(unsupported.code)
  })
})
