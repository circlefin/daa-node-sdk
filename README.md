# Circle Digital Asset Accounts JavaScript SDKs

Two npm packages that together add passkey-based Strong Customer Authentication
(SCA) to your integration with Circle's Digital Asset Accounts. Use them to
register a passkey for your end user and to have that user approve sensitive
operations, such as a transfer or a withdrawal, with it.

| Package                                               | Runs on                 | Holds your Circle API key | Purpose                                                                |
| ----------------------------------------------------- | ----------------------- | ------------------------- | ---------------------------------------------------------------------- |
| [`@circle-fin/daa-node-sdk`](packages/node/README.md) | Your backend (Node.js)  | Yes                       | Calls Circle's passkey endpoints with your API key                     |
| [`@circle-fin/daa-web-sdk`](packages/web/README.md)   | Your end user's browser | Never                     | Shows Circle's passkey ceremony in your web app and returns its result |

## How the two packages fit together

Your backend and your web app each do one half of the flow. Only a short-lived
`frameToken` passes from your backend to the browser. Your API key never does.

1. **Backend:** `daa.passkeys.createRegistration(...)` opens a registration and
   returns a `registrationId` and a `frameToken`.
2. **Backend to browser:** send the `frameToken` (and nothing else from that
   response) to your page.
3. **Browser:** `sca.enroll(frameToken, ...)` shows Circle's ceremony. The user
   creates a passkey, and the SDK returns the browser's result.
4. **Browser to backend:** send that result back to your backend unchanged.
5. **Backend:** `daa.passkeys.complete(...)` finishes the registration.

Approving an operation follows the same pattern with
`daa.passkeys.openChallenge(...)` on the backend and `sca.approve(...)` in the
browser. Each package README has a complete example.

## Requirements

- Node.js 22 or later, for the backend package and for the toolchain that
  installs and bundles the browser package.
- A Circle API key for Digital Asset Accounts, and the origin of each web app
  that will show the ceremony registered with Circle. Contact your Circle
  representative if you do not have these.
- Both packages are ESM-only.

## Documentation

- [Server SDK guide](packages/node/README.md)
- [Browser SDK guide](packages/web/README.md)
- [How-to: Implement Strong Customer Authentication](https://developers.circle.com/digital-asset-accounts/howtos/strong-customer-authentication)
  in Circle's developer documentation, for the end-to-end integration flow
- [Digital Asset Accounts API reference](https://developers.circle.com/api-reference/digital-asset-accounts)

## Development

This repository is a pnpm and Turborepo workspace. Use Node.js 22 or later.

```bash
pnpm install
pnpm lint          # eslint, no --fix
pnpm check:type
pnpm test:coverage # what CI runs
pnpm build
pnpm format:check
```

## Support

For integration questions, contact your Circle representative or use the
support channels listed at [developers.circle.com](https://developers.circle.com).
Open a GitHub issue for bugs in the SDKs themselves. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Do not report security vulnerabilities in public issues. Report them privately
through Circle's [Vulnerability Disclosure Program](https://hackerone.com/circle-bbp).
See [SECURITY.md](SECURITY.md) for the full policy.

## License

[Apache License 2.0](LICENSE)
