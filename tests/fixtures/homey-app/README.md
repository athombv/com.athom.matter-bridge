# Matter Bridge fixture app

This is an SDK v3 device simulator installed only in the integration runner's disposable SHS. It is packaged separately from Matter Bridge and is not an App Store app.

`profiles.json` is the shared catalogue for the generated driver manifests, device initialization, lab seeding, and fixture contract tests. `scripts/integration/fixture-app.mjs` generates the per-driver entry files in ignored build staging and supplies the repository's images for CLI validation. Generated drivers use `onMapDeviceClass` to select `FixtureDevice`.

Commands invoke real SDK capability listeners, are recorded (last 100 attempts), and can be rejected per capability. Reports invoke SDK `setCapabilityValue` directly so read-only measurements and alarms can be simulated. Availability uses `setAvailable` / `setUnavailable`. Initialized capability values survive fixture-app restarts; command history and rejection flags are intentionally session-local.

The app's authenticated HTTP API exposes `GET /state` and `GET|POST /devices/:profile/:id`. The latter ID is the device's pairing-data ID, not its Homey device ID. POST accepts one operation:

- `report`: `values` is an object mapping capabilities to values.
- `availability`: `available` is a boolean.
- `reject`: `capability` names a command capability; `rejected` is a boolean.
- `clear-commands`: clears recorded attempts.

The normal CLI wraps these operations. See `docs/integration-testing.md` at the repository root for usage and coverage limits.
