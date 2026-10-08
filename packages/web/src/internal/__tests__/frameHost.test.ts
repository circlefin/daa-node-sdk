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

import { createDomFrameHost } from '../frameHost.js'

/**
 * The DOM host's *production* paths need a browser, so this suite does not
 * cover them.
 *
 * Its refusal to run without a browser is different: that branch is reachable on
 * plain Node, which is precisely the environment it exists to reject. Left
 * untested it would be the one path an SSR consumer hits first.
 */
describe('createDomFrameHost', () => {
  it('refuses to build without a DOM, naming the seam as the way out', () => {
    expect(() => createDomFrameHost('https://daa-sca.circle.com')).toThrow(
      /requires a browser environment/,
    )
    // The message has to point somewhere: a consumer hitting this on a server
    // render needs to know the fix is to not construct here, not to polyfill.
    expect(() => createDomFrameHost('https://daa-sca.circle.com')).toThrow(/inject a FrameHost/)
  })
})
