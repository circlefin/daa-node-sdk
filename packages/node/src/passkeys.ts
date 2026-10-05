/**
 * The passkey surface of the DAA public API.
 *
 * Five routes, and exactly the five the API gateway exposes under
 * `/v1/accounts/passkeys`. The public path has no `daa` segment, and two
 * service routes are deliberately unreachable from here:
 *
 * - `POST …/challenges/{id}/validate` is **not part of the public API**.
 *   Challenges are validated as part of the gated money-movement request
 *   itself, so there is no method for it here.
 * - `GET /v1/daa/frame/ceremony` is the Circle ceremony app's, authorized by a
 *   capability token rather than an API key.
 */

export interface CreateRegistrationRequest {
  /** The end user. Ownership is verified against the calling entity. */
  readonly clientEntityId: string
  /**
   * Replaying this returns the original ceremony rather than opening a second
   * one: the same `registrationId` and the same `expiresAt`.
   *
   * **It mints a new `frameToken` and invalidates the previous one.**
   * Measured against smokebox — three calls under one key, twice — and the
   * reason is in DAA: the raw token is never stored, only its SHA-256, in a
   * single column under a unique index. A replay therefore cannot hand back
   * the original bearer value, so it generates a fresh one and *overwrites*
   * that hash, rotating which token the ceremony frame will accept. The
   * earlier token stops resolving there.
   *
   * The consequence runs against what an idempotency key usually buys you,
   * so it is worth stating plainly: **once you have given the token to the
   * page, do not retry this call under the same key.** The retry answers
   * `200` with the same `registrationId` and looks like a clean replay,
   * while the ceremony the user is part-way through stops working — and
   * nothing in that response says so. Retrying a call whose response you
   * never received is safe. Retrying one whose token you already delivered
   * is not.
   *
   * Reusing the key with a different `spcCapable` is
   * `DAA_ERROR_CODES.IDEMPOTENCY_KEY_REUSED` (409) rather than a replay —
   * and note that omitting the field and passing `false` are the *same*
   * request, so only a true/false disagreement conflicts.
   *
   * A different `embedOrigin` is the same 409. Omitting it on the replay is
   * not a conflict: the original ceremony comes back, still bound to the
   * origin it was opened for.
   *
   * Reusing it with a different `clientEntityId` is the same conflict in
   * principle, but you will usually see `CLIENT_ENTITY_NOT_OWNED` (420001)
   * instead: ownership is verified before the idempotency lookup, so an end
   * user you do not own fails that check first. The conflict only surfaces
   * when the other `clientEntityId` is one you do own.
   */
  readonly idempotencyKey: string
  /**
   * Request the WebAuthn `payment` extension, for Secure Payment Confirmation.
   *
   * **Irreversible per credential and only settable now.** A credential
   * enrolled without it can never be used with SPC. Inert in v1 — the SPC
   * branch is deferred — but requesting it costs nothing on a browser that
   * does not support it.
   */
  readonly spcCapable?: boolean
  /**
   * The origin of your page that embeds the enrollment ceremony, for example
   * `https://app.example.com`. It must exactly match one of the origins
   * Circle has approved for you: scheme, host and port, with no trailing
   * slash or path. At most 512 characters.
   *
   * **Send it on every call.** It is required once you have more than one
   * approved origin: without it, DAA cannot tell which page the ceremony runs
   * from and answers `API_PARAMETER_INVALID` (`code: 2`). With exactly one
   * approved origin, omitting it uses that one — but an integration that
   * relies on that starts failing the day a second origin is approved. A
   * blank value, or one that matches none of your approved origins, is the
   * same `API_PARAMETER_INVALID`: it is your request to fix, not your
   * onboarding. `DAA_ERROR_CODES.SCA_ORIGIN_NOT_CONFIGURED` means you have no
   * approved origin at all.
   *
   * The ceremony is bound to this origin: the frame posts its result only to
   * it, and an embedded ceremony whose top-level page is any other origin is
   * rejected. If this origin is removed from your approved origins before the
   * ceremony completes, the ceremony fails.
   */
  readonly embedOrigin?: string
}

export interface RegistrationCreated {
  readonly registrationId: string
  /** RFC 3339. Ten minutes — the ceremony's life, not the credential's. */
  readonly expiresAt: string
  /**
   * Hand this to the browser and nothing else.
   *
   * A capability token: holding it grants a read of exactly this one ceremony.
   * Treat it as a secret in transit. Do **not** send the rest of this response
   * to the browser — the ceremony's own summary is fetched by the Circle frame
   * from Circle, which is what keeps it out of your code.
   */
  readonly frameToken: string
}

export interface CompleteRegistrationRequest {
  readonly registrationId: string
  /**
   * The browser's `RegistrationResponseJSON`, exactly as
   * `@circle-fin/daa-web-sdk`'s `enroll()` returned it.
   *
   * **Relay it verbatim.** Re-serializing it invalidates the signature over
   * `clientDataJSON`. Typed as an opaque object for that reason rather than
   * modeled here.
   */
  readonly attestationResponse: Readonly<Record<string, unknown>>
}

export interface PasskeyCreated {
  readonly passkeyId: string
  /** base64url. What the browser sends back on every future ceremony. */
  readonly credentialId: string
}

export interface ListPasskeysQuery {
  /**
   * End user whose passkeys are listed. The API verifies that this ID belongs
   * to the entity authenticated by the SDK's API key; your application must
   * separately authorize that user for the signed-in caller.
   */
  readonly clientEntityId: string
}

export interface PasskeyView {
  readonly passkeyId: string
  readonly credentialId: string
  /** COSE algorithm: -7 (ES256) or -257 (RS256), pinned at registration. */
  readonly algorithm: number
  /**
   * The authenticator model, as a **hyphenated UUID** — the form the FIDO
   * Metadata Service uses, not base64url. Self-asserted and not validated.
   */
  readonly aaguid: string
  /** As received. May be `none` even though DAA requests `direct`. */
  readonly attestationFormat: string
  /** Fed into `allowCredentials` on future ceremonies. */
  readonly transports: readonly string[]
  /** Self-asserted: can this credential sync across devices. */
  readonly backupEligible: boolean
  /** Self-asserted: is it currently backed up. */
  readonly backupState: boolean
  /** Many synced passkeys always report 0. That is not itself a red flag. */
  readonly signCount: number
  readonly rpId: string
  /**
   * What was **requested** at enrollment, not a verified outcome. WebAuthn
   * gives no confirmation the payment extension was honored, so `true` means
   * "asked for". Your own runtime browser-support check — not this field — is
   * what decides whether SPC can actually run.
   */
  readonly paymentEligible: boolean
  readonly createDate: string
  readonly updateDate: string
  /**
   * Set when revoked. Revoked credentials are **returned**, never omitted —
   * diagnosing a failed step-up needs "exists but revoked" told apart from
   * "no credential".
   */
  readonly revokedDate?: string
}

export interface RevokePasskeyQuery {
  /**
   * End user whose passkey is revoked. The API verifies that this ID belongs
   * to the entity authenticated by the SDK's API key; your application must
   * separately authorize that user for the signed-in caller.
   */
  readonly clientEntityId: string
}

/**
 * The headers a step-up round trip travels on.
 *
 * Named here because none of them are this SDK's to send: `openChallenge`
 * returns a `challengeId` and a `frameToken`, the browser produces an
 * assertion, and then **you** resend the gated request — on your own route,
 * with your own client. A name you type is a name you can typo, and two of
 * these fail in ways that do not say "header".
 */
export const SCA_HEADERS = {
  /** The `challengeId` from `openChallenge`. Send on the gated request. */
  challengeId: 'X-Sca-Challenge-Id',
  /**
   * The browser's assertion, as **raw JSON text**.
   * `@circle-fin/daa-web-sdk`'s `approve()` returns this value ready to send.
   *
   * Not base64url of that JSON — DAA rejects it with `"assertion is not valid
   * strict JSON"`.
   */
  assertion: 'X-Sca-Assertion',
} as const

/**
 * There is no response header telling you SCA applied, and you do not need
 * one.
 *
 * Whether SCA applies to an end user is Circle's determination, not yours —
 * it follows the entity's legal entity, and Circle is the regulated party
 * that has to get it right. A request Circle did not gate simply succeeds.
 *
 * Worth saying only because `X-Sca-Authorization-Id` exists and is easy to
 * mistake for that signal. It is not: Circle stamps it on the request it
 * proxies *inward*, so the service executing the movement can record which
 * authorization permitted it, and a copy sent by a caller is stripped at
 * ingress. It never travels back out, which is why `SCA_HEADERS` does not
 * name it. If you were looking for it, stop.
 *
 * If you believe an entity should be in scope and its transfers are going
 * through without a ceremony, that is a question for Circle.
 */

export interface OpenChallengeRequest {
  readonly clientEntityId: string
  /**
   * The operation being authorized, as the **uppercase enum name** —
   * `TRANSFER`, not `transfer`.
   *
   * DAA binds this by name: `OperationDiscriminator` declares no `@JsonValue`,
   * so Jackson matches the constant. Lowercase happens to work today only
   * because Dropwizard enables `ACCEPT_CASE_INSENSITIVE_ENUMS`, and nothing
   * guarantees that stays on.
   *
   * Five operations have an SCA intent parser today — **`TRANSFER`**,
   * **`WITHDRAWAL`**, **`WIRE_ACCOUNT_CREATE`**, **`ADDRESS_BOOK_ADD`** and
   * **`ADDRESS_BOOK_DELETE`** — and the rest of DAA's vocabulary parses but
   * comes back as `DAA_ERROR_CODES.SCA_OPERATION_NOT_IMPLEMENTED`.
   *
   * "Implemented" is not "enforced", and the two lists move separately. An
   * operation having a parser means a challenge can be opened for it;
   * whether the *gated route* actually consults SCA is the API gateway's
   * middleware. They agree today — `POST /v1/accounts/transfers`,
   * `POST /v1/accounts/withdrawals`, `POST /v1/banks/wires`,
   * `POST /v1/addresses/recipient` and `DELETE /v1/addresses/recipient/{id}`
   * are all gated — but they are maintained apart, so a challenge you can
   * open is not necessarily a request that will be refused without one.
   *
   * Not narrowed to a union for the same reason `DaaApiError.code` is not: DAA
   * adds an operation without this SDK being republished, and a union here
   * would reject the new one until it was.
   */
  readonly operation: string
  /**
   * The gated route's own request body, verbatim. Shape is selected by
   * `operation`.
   *
   * The shape is the gated route's own request record, not an SCA-side copy
   * of it, so the contract lives there. One field is worth naming anyway
   * because it is the one nobody guesses: a blockchain `destination` takes
   * `{ type: 'verified_blockchain', addressId }` — an **address-book UUID,
   * not a raw chain address**. An internal transfer is
   * `{ type: 'account', id }`. `source` is optional.
   *
   * A shape DAA cannot parse is rejected here as `API_PARAMETER_INVALID`,
   * which arrives as `code: 2` — ordinary parameter validation, not one of
   * the SCA codes, and observed as that against smokebox. So there is
   * nothing SCA-specific to branch on: check the body against the route you
   * are gating.
   *
   * **On the four bodied operations, a member DAA does not recognize is
   * neither refused nor inert.** Its intent mapper enables
   * `FAIL_ON_UNKNOWN_PROPERTIES`, but `TRANSFER`, `WITHDRAWAL`,
   * `ADDRESS_BOOK_ADD` and `WIRE_ACCOUNT_CREATE` all bind records carrying
   * `@JsonIgnoreProperties(ignoreUnknown = true)`, which Jackson honors
   * first — so the member is dropped from the typed record, and it is that
   * record which renders the summary your user approves. The digest the
   * challenge is bound to is taken over the JSON you sent, unknown member
   * and all. A misspelled field therefore does not fail: it is missing from
   * what the user approved, present in what was signed, and reported
   * nowhere. Check your field names against the gated route's own contract;
   * DAA does not check them for you.
   *
   * `ADDRESS_BOOK_DELETE` is the only exception, and the safer behavior:
   * alone among the five it has no request body, so its intent record is
   * empty and carries no such annotation, the mapper's setting applies, and
   * any member at all is refused —
   * `API_PARAMETER_INVALID` (`code: 2`) at `openChallenge`. Measured against
   * smokebox: the same stray member that a transfer intent accepts with a
   * `201` is a `400` here.
   *
   * Two SCA codes are worth telling apart from that, because only one of
   * them can come from this call:
   *
   * - `SCA_OPERATION_NOT_IMPLEMENTED` (420062) *is* raised here — the
   *   operation is in SCA scope but has no implementation registered yet.
   *   The request was correct; the gate is simply ahead of the operation.
   * - `SCA_INTENT_UNRECOGNIZED` (420060) is *not* raised here, despite the
   *   name. It belongs to the later enforcement check on the gated request,
   *   and reports that the intent carries no identifier the scope check can
   *   read — a blank source account, or a missing `clientEntityId`.
   *
   * **Send the identical body when you resend the gated request.** The
   * challenge is bound to a digest of this intent, canonicalized —
   * `idempotencyKey` included — and DAA recomputes that digest twice: against
   * the challenge it stored, and against the digest inside the signature. So
   * a retry under a *new* idempotency key is a different intent and needs a
   * new challenge. That is the point: one approval cannot be replayed across
   * two submissions.
   *
   * The round trip, which this SDK does not perform for you:
   *
   * ```ts
   * const { challengeId, frameToken } = await daa.passkeys.openChallenge({
   *   clientEntityId, operation: 'TRANSFER', intent: body,
   * })
   *
   * // Hand ONLY frameToken to the page. It runs the ceremony with
   * // @circle-fin/daa-web-sdk's approve(), which returns the header value,
   * // and sends that back to you over your own authenticated channel.
   * const assertion: string = await receiveFromPage()
   *
   * await fetch(`${baseUrl}/v1/accounts/transfers`, {
   *   method: 'POST',
   *   headers: {
   *     authorization: `Bearer ${apiKey}`,
   *     'content-type': 'application/json',
   *     [SCA_HEADERS.challengeId]: challengeId,
   *     [SCA_HEADERS.assertion]: assertion,
   *   },
   *   body: JSON.stringify(body), // the same body, not a rebuilt one
   * })
   * ```
   *
   * A bodyless operation has no body to send: pass `{}` and name its subject
   * in `pathParameters` below.
   */
  readonly intent: Readonly<Record<string, unknown>>
  /**
   * Route path parameters, for an operation whose subject is named in the URL
   * rather than in a body.
   *
   * `ADDRESS_BOOK_DELETE` is the only one today. `DELETE
   * /v1/addresses/recipient/{id}` carries no body, so `intent` is `{}` and
   * the recipient being unlinked is named here as `{ id }`. DAA folds the
   * value into the same canonical bytes the assertion signs, which is what
   * scopes the approval to that one recipient: measured against smokebox, a
   * challenge opened for recipient A and submitted against recipient B comes
   * back `420047` `SCA_INTENT_MISMATCH` rather than authorizing the delete.
   *
   * **The key is a contract with the gated route, not a free-form label.**
   * The API gateway names the route parameters it forwards and DAA reads the
   * same key back out; they are the same word by agreement. Disagreeing
   * fails, and fails early — DAA cannot read the route parameter it needs,
   * so `openChallenge` itself answers `API_PARAMETER_INVALID` (`code: 2`)
   * and there is no challenge to submit. On the gated request the same
   * disagreement is the API gateway's to catch: a named parameter that reads
   * back blank is a `400` before DAA is called at all. Send exactly what the
   * route declares: `id` for the delete above.
   *
   * The value is the id as it appears in the URL you are about to call. DAA
   * refuses a non-canonical UUID spelling instead of normalizing it, so that
   * the path you send, the bytes that get signed, and the row DAA looks up
   * are all the same string.
   *
   * Omit it for a bodied operation — DAA defaults it to an empty map, which
   * is what every bodied operation's digest is already taken over.
   *
   * The round trip, which differs from the bodied one above in that there is
   * no body to resend — one variable is the whole binding, so it has to be
   * the same string in both places:
   *
   * ```ts
   * const { challengeId, frameToken } = await daa.passkeys.openChallenge({
   *   clientEntityId,
   *   operation: 'ADDRESS_BOOK_DELETE',
   *   intent: {}, // no request body to describe
   *   pathParameters: { id: recipientId },
   * })
   *
   * const assertion: string = await receiveFromPage()
   *
   * await fetch(
   *   `${baseUrl}/v1/addresses/recipient/${recipientId}?clientEntityId=${clientEntityId}`,
   *   {
   *     method: 'DELETE',
   *     headers: {
   *       authorization: `Bearer ${apiKey}`,
   *       [SCA_HEADERS.challengeId]: challengeId,
   *       [SCA_HEADERS.assertion]: assertion,
   *     },
   *     // No body, and no content-type. What the user approved is the path.
   *   },
   * )
   * ```
   *
   * What the user is shown is built from the recipient DAA looks up, not from
   * anything you send — for the call above, smokebox answers:
   *
   * ```json
   * { "type": "address_book", "description": "fwd3870",
   *   "address": "0x672cda23300e4ffd8bfb04f6f827d26e00000000", "network": "ETH" }
   * ```
   */
  readonly pathParameters?: Readonly<Record<string, string>>
  /**
   * Defaults to `webauthn` server-side. Anything else — including `spc`, which
   * is deferred to V2 — is **rejected rather than defaulted**, so a typo
   * cannot silently downgrade a ceremony.
   */
  readonly ceremonyKind?: string
  /**
   * The origin of your page that embeds the step-up ceremony, for example
   * `https://app.example.com`. It must exactly match one of the origins
   * Circle has approved for you: scheme, host and port, with no trailing
   * slash or path. At most 512 characters.
   *
   * **Send it on every call.** It is required once you have more than one
   * approved origin: without it, DAA cannot tell which page the ceremony runs
   * from and answers `API_PARAMETER_INVALID` (`code: 2`). With exactly one
   * approved origin, omitting it uses that one — but an integration that
   * relies on that starts failing the day a second origin is approved. A
   * blank value, or one that matches none of your approved origins, is the
   * same `API_PARAMETER_INVALID`: it is your request to fix, not your
   * onboarding. `DAA_ERROR_CODES.SCA_ORIGIN_NOT_CONFIGURED` means you have no
   * approved origin at all.
   *
   * The ceremony is bound to this origin: the frame posts its result only to
   * it, and an embedded ceremony whose top-level page is any other origin is
   * rejected. If this origin is removed from your approved origins before the
   * ceremony completes, the ceremony fails.
   */
  readonly embedOrigin?: string
}

export interface ChallengeOpened {
  readonly challengeId: string
  /** RFC 3339. Five minutes. */
  readonly expiresAt: string
  /**
   * Server-authored display fields, **for your records — not for you to
   * render**. The copy the user approves is fetched independently by the
   * Circle frame; rendering your own pre-confirmation from this is rendering
   * untrusted copy.
   */
  readonly summary: Readonly<Record<string, unknown>>
  /** Hand to the browser. Same capability semantics as `RegistrationCreated.frameToken`. */
  readonly frameToken: string
}
