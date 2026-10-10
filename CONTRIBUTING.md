# Contributing

Use Node.js 20.19+ (or 22.12+) and run `npm ci`.

Before submitting a change, run `npm run check`, `npm run build:demo`, and `npm run test:browser` with Chromium installed. Run `npm pack --dry-run` when changing exports or build configuration.

Keep the primary host/join/input/state API small. Put transport-specific behavior in adapters. Cover protocol changes with tests for untrusted senders, admission, sequence ordering, disconnect and cleanup. Bump the protocol/invitation prefix for incompatible wire changes and document migration.

Do not commit credentials, generated bundles or dependencies. Follow the MIT license and retain upstream attribution. File issues with browser versions, signaling strategy, network types and reproduction steps; remove invitation secrets and TURN credentials from logs.
