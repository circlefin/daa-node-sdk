/**
 * Whether a passkey ceremony can run inside a cross-origin iframe here, end to
 * end — the browser completing it, and DAA accepting what it produced.
 *
 * There is no feature test for it. The only way to find out from inside the
 * frame is to call `navigator.credentials.create()` and watch it fail, and by
 * then the click that started the ceremony has been spent — too late to open a
 * window without the popup blocker stopping it. `featurePolicy.allowsFeature`
 * is Chromium-only, and `PublicKeyCredential.getClientCapabilities()` does not
 * report the embedded case. So the decision is made up front, from the engine.
 *
 * WebKit is the engine that fails, once for each ceremony: Safari on macOS,
 * and every browser on iOS and iPadOS, which are all WebKit underneath
 * whatever their name.
 *
 * - **Registration** is refused in the frame with `NotAllowedError` even when
 *   the `allow` attribute delegates `publickey-credentials-create`, and the
 *   frame cannot tell that apart from the user canceling.
 * - **Step-up** completes in the frame, but WebKit leaves `topOrigin` out of
 *   `clientDataJSON`. DAA requires it for every cross-origin ceremony — it is
 *   the browser's proof of which partner page embeds the Circle document — so
 *   it rejects the assertion as `SCA_ORIGIN_NOT_ALLOWED`, which reaches the
 *   distributor as the generic "The step-up authentication could not be
 *   verified". Measured in sandbox against Safari: the rejection is counted by
 *   `daa.sca.webauthn.cross_origin_top_origin_absent`.
 *
 * A top-level window has neither problem: the ceremony is not cross-origin,
 * so there is nothing to delegate and no `topOrigin` to prove. So on WebKit
 * both `enroll` and `approve` run in one.
 *
 * Detected by `navigator.vendor`, not the user-agent string. Every WebKit
 * browser reports `Apple Computer, Inc.` — Chrome and Firefox on iOS
 * included, which is the case a UA check gets wrong, since their UA names
 * themselves rather than the engine. Chromium reports `Google Inc.` and Gecko
 * reports the empty string.
 */
export const supportsEmbeddedCeremonies = (
  navigator: { readonly vendor?: string } | undefined,
): boolean => !(navigator?.vendor ?? '').startsWith('Apple')
