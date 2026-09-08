# Matter Bridge for Homey Pro

This app exposes Homey Pro's devices to Matter, so users can include them in Apple Home, Google Home etc.

## Pairing platforms

Open the app's settings and scan the initial QR code in your first Matter platform.
After pairing, select the Homey devices you want to share. Every connected platform
receives the same selection.

To connect an additional platform, select **Add another platform**. Scan the new QR
code or copy its numeric code into that platform within five minutes. Each attempt
has fresh temporary credentials; existing connections and device identities stay
intact. **Stop pairing** cancels the attempt, including unfinished commissioning.
Successful pairing, expiry, cancellation, and app shutdown clear the temporary code.

Refreshing or leaving settings does not cancel pairing. Settings restores the active
attempt and its remaining time. If another platform opened pairing, continue there
or wait for it to finish. Restarting the app closes temporary pairing and preserves
established connections and selected devices.

## Runtime and tests

Requires Homey **12.9.0 or later**, the [Node.js 22 app baseline](https://apps.developer.homey.app/upgrade-guides/node-22).
`homey-api` is pinned to **3.19.4** and Matter.js remains **0.15.6** in the lockfile.
`homey-api` declares Node.js 24 or later; using it on Node.js 22 is a deliberate,
tested compatibility exception. Accept the npm engine warning without changing
dependency metadata or npm engine settings. Recheck this exception when upgrading.

Under Node.js 22:

```bash
npm ci
npm test
```

The tests exercise real Matter controllers over local UDP/mDNS with in-memory
storage, including multiple fabrics, rollback, cancellation, expiry, competing
platforms, and restart. They also test the settings panel with mocked Homey responses
and `homey-api` loading, `createAppAPI`, discovery, capability subscriptions, and
reconnection against a local HTTP/Socket.IO fixture. Allow local multicast for the
Matter integration test. No physical devices or existing Homey pairings are used.

Use the Homey CLI's supported Node version for packaging:

```bash
homey app validate --level verified
npm audit --omit=dev
homey app install
```

Do not use `--clean` when updating an existing installation. Acceptance testing on
Homey requires adding a second external platform, verifying both control the same
selected devices, and repeating those checks after an app restart.

The production audit on 2026-09-08 reports seven affected dependency entries
(three high, four moderate) in the existing `homey-api` dependency tree, unchanged
by this update. Updating these transitive dependencies is separate work.

## Usage

```bash
$ homey app run --remote
```

We need to run with `--remote` due to the userdata, mDNS advertisements and IP address.

## Usage (Standalone)

To run on your Mac/Linux PC for faster debugging:

```bash
$ npm run standalone
```

This will run a separate server, but you don't need to upload it to Homey Pro every time, which saves a lot of precious development time. It automatically reloads on file changes.

Scan the QR Code in the terminal with e.g. Apple Home to perform the initial pairing.

> See .envrc.sample for the required environment variables.

## Specification

Download the latest *Matter Application Cluster Specification* from https://csa-iot.org/developer-resource/specifications-download-request/.
