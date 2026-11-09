# Testing the installed app against Homey SHS

This suite packages and installs the app in a disposable Homey Self-Hosted Server (SHS), installs a dedicated fixture app and pairs its SDK devices through Homey's pairing API, and commissions a Matter.js controller over UDP/mDNS. It exercises the Homey SDK, homey-api subscriptions, app HTTP routes, persisted Matter endpoints, and the protocol in both directions. No bridge internals or mocked capability subscriptions are used.

## Requirements and first run

Use Linux with a local Docker Engine, Node.js 22.20 or newer, and Homey CLI 4.4.4. The SHS container requires privileged mode. Docker Desktop and remote Docker daemons are not currently verified; the runner uses local bind mounts and IPv6 Docker networking.

```sh
npm ci
npm install --global homey@4.4.4
npm run test:integration
```

No Athom account, Homey CLI login, physical Homey, real devices, activation backup, private repository, or repository secrets are needed. Every test run and lab startup pulls the public `ghcr.io/athombv/homey-shs:latest` image, including when it is already cached. A failed pull stops the run. Each run builds the current working tree, including local source edits and untracked source files not excluded by Git, in a temporary staging directory. The production checkout and its dependencies are not modified by packaging.

The default smoke scenario checks:

- SDK light and socket fixtures shared through the installed bridge app.
- Homey on/off and dim updates arriving as Matter reads and subscription reports.
- A Matter command updating the actual Homey device state.
- Unsharing removing a Matter endpoint while the other device keeps working.

The runner uses a fresh generated seed, isolated network, and Docker volume for every test run. It saves both stdout and stderr and removes its controller, SHS container, network, and volume after success, assertion failure, setup failure, or an ordinary interrupt. Unique resource names permit tests in separate worktrees or concurrent runs. A persistent manual lab is independent of these test runs.

## Keep a backend running for manual testing

```sh
npm run shs -- up
npm run shs -- devices
npm run shs -- set 'Lab light' onoff true
npm run shs -- set 'Lab light' dim 0.25
npm run shs -- set 'Lab socket' onoff true
# Simulate an incoming measurement or alarm through the device SDK.
npm run shs -- report 'Lab measure-temperature' measure_temperature 23.5
npm run shs -- report 'Lab alarm-motion' alarm_motion true
# Control availability and command failures.
npm run shs -- availability 'Lab thermostat' false
npm run shs -- availability 'Lab thermostat' true
npm run shs -- reject 'Lab light' onoff true
npm run shs -- commands 'Lab light'
npm run shs -- reject 'Lab light' onoff false
npm run shs -- logs
npm run shs -- down
```

`up` installs the fixture app, pairs the complete 28-profile catalogue, installs the current bridge app, and shares the fixtures. Device names are `Lab <profile>`, for example `Lab light`, `Lab thermostat`, and `Lab alarm-motion`. It prints a dynamically allocated loopback HTTP address. The synthetic local login is `bridge-test` / `bridge-test`; these are public test-only credentials. CLI commands reuse an ephemeral session in ignored `output/integration/<run>/session.json` to avoid repeated-login rate limits. The session file is excluded from CI artifact uploads. A web app supporting local SHS login can use that address. The runner does not include or require the private Homey web app.

`set` sends a user/controller command through Homey to the fixture driver. `report` emits a simulated device update through SDK `setCapabilityValue`, including read-only sensors. `availability` changes SDK availability, `reject` controls rejection for a command capability, and `commands` shows the last 100 driver command attempts with their acceptance status. Controls accept a device name or ID and JSON values. They talk only to this runner's disposable backend. `logs` follows complete timestamped SHS/app stdout and stderr. `down` saves the logs and removes the lab and its data. A second `up` refuses to overwrite a running lab; use `down` then `up` to install new source changes.

The HTTP port is loopback-only. SHS remains on an internal Docker network with no outbound route; a fixed-destination proxy exposes only its HTTP service. The Matter controller used by tests shares the SHS network namespace. This lab is intended for local software testing; it does not advertise a bridge to physical controllers on the household LAN.

## Verify a branch or regression

The test harness remains from this checkout while `--ref` selects which version of the app to package. This lets a new regression test demonstrate a failure before a fix and success after it, without cherry-picking the harness into both branches.

```sh
# Run the smoke scenario against a Git ref.
npm run test:integration -- --ref origin/master

# The re-sharing regression fails on this pre-fix framework baseline.
npm run test:integration -- --scenario reshare --ref 3f488d8

# Fetch #40, then run exactly the same scenario against its app code.
git fetch origin pull/40/head:refs/remotes/origin/pr-40
npm run test:integration -- --scenario reshare --ref origin/pr-40

# A persistent lab can also install an arbitrary ref.
npm run shs -- up --ref origin/pr-40
```

`reshare` repeats removal/recreation three times, writes state while unshared, exercises repeated enable/disable calls, and verifies live updates, dimming, unchanged control-device identity, push reports on the original subscription, and commands back to SHS. It runs as a normal CI job alongside the other integration scenarios. Run it locally with `--scenario reshare`; the default local command still selects the smoke scenario. A regression failure exits nonzero.

Stored initial state after recreation is a separate concern from live updates (see #33). The regression prints the observed initial state, synchronizes both sides, and then demands fresh subscription reports for actual value transitions. Matter does not owe a change report for writing a value it already has.

## Reports and troubleshooting

Each run prints its directory under ignored `output/integration/`. It contains:

- `result.json`: outcome, source commit/ref, dirty-worktree flag, requested image reference, resolved image ID/repository digests and timestamps.
- `results.xml` and `tests.log`: JUnit and TAP results, including assertion failures.
- `build.log` and `setup.log`: packaging and installation output.
- `image.log`: image pull output, including the registry digest.
- `homey-shs.log`: complete timestamped SHS and app stdout/stderr, including startup.

The `SHS Integration` GitHub workflow runs `smoke`, `fixtures`, `devices`, `reshare`, and `power` in separate fresh environments on relevant pull requests and manual dispatch, and uploads reports/logs even on failure. It uses the same runner and pulls `:latest` for each scenario, just like local testing. CI needs no secrets. Compare recorded image digests when comparing runs: a new release can change the backend between runs.

SHS logs may include failed cloud, weather, update and outbound-IP requests because the backend is deliberately offline. Test success is based on device and protocol assertions, not an empty error log. Logs and protocol artifacts may contain ephemeral test tokens or pairing codes; keep them in ignored output or short-lived CI artifacts.

SIGKILL or host failure cannot run cleanup. Docker resources are labeled `matter-bridge.integration` with a checkout-specific owner value. Inspect those labels before manually deleting interrupted runs; never use a global Docker prune for this workflow. A retained manual lab also has an ignored `output/integration/lab.json` manifest for `down`.

## Extend the suite

Device definitions live in `tests/fixtures/homey-app/profiles.json`. Each entry declares the Homey class, initial capability values, supported command capabilities with example command values, and capability options. The fixture app builder generates a distinct SDK driver entry for each profile. The same catalogue drives lab seeding and automated fixture checks; adding a profile automatically adds it to both.

The catalogue includes six light variants, plain and power-reporting sockets (including an unknown initial reading), a generic on/off device, thermostat/heater/heat-pump/air-conditioning profiles, a lock, position/state coverings, and eleven measurement/alarm sensors. The fixture app implements driver reports, recorded commands, availability and explicit rejection controls using the [Homey SDK Device API](https://apps-sdk-v3.developer.homey.app/Device.html). It runs as a separately installed app, with no bridge internals or native virtual driver shortcuts.

Fixture startup pairs and initializes the catalogue **before installing Matter Bridge**. This establishes a stable baseline of existing Homey devices. The `power` scenario additionally pairs an unknown-power socket while the bridge and Matter controller are running, shares it, and verifies discovery, commands and subsequent reports. Live pairing for other device classes remains outside this scenario.

The `power` regression checks the first Matter read before any source update: 12 W must be reported as 12000 mW. Unknown power remains `null`; zero remains zero. Live reports also cover fractional watt readings, negative/exported power, returning to unknown and recovering to a numeric reading. Run `npm run test:integration -- --scenario power --ref ccac276` to reproduce the original unit-conversion and unknown-power initialization failures against the pre-fix app.

The re-sharing regression observed Homey `false` versus initial Matter `true` on its first cycle against #40, consistent with the stored-state concern described above. Restoring fresh values over persisted Matter state remains a separate production follow-up; the power scenario uses new endpoints.

Run each suite explicitly:

```sh
npm run test:integration -- --scenario fixtures
npm run test:integration -- --scenario devices
npm run test:integration -- --scenario power
```

- `fixtures` verifies all 28 SDK profiles through SHS: driver identity, class, capabilities, initial state, successful/rejected commands, read-only reports, declared temperature limits and valid boundary values, availability, and invalid-capability rejection. These checks establish simulator behavior independently of Matter mappings.
- `devices` commissions all 28 profiles, checks 25 representative live reports against Matter reads and push subscriptions, and verifies a controller command reaching the SDK driver, including rejection and unchanged state after rejection.
- `smoke` retains the small light/socket lifecycle check.
- `reshare` guards the sharing lifecycle in normal CI, including the regression fixed by #40.
- `power` verifies initial power conversion and a newly paired socket with an unknown reading, including live reports and an on/off command over the existing controller connection.

This is representative mapping coverage, not every combination or command. Colour-temperature conversion, every thermostat mode, all reverse command paths, initial-state restoration after restart/re-sharing, and Matter reachability for unavailable devices still need dedicated scenarios. Fixture availability is currently asserted in Homey; do not infer bridge reachability coverage from it.

`createBridge(t)` selects prepared fixtures, owns sharing and controller/device teardown, and accepts a profile list. `HomeyClient` separates commands (`set`) from device reports (`report`). `MatterController` discovers the child endpoint serving the requested cluster, including multi-endpoint HVAC devices. Add protocol assertions to `devices.test.mjs` or a new scenario when introducing a profile: automatic seeding alone does not verify its Matter mapping.

The app and controller currently use the same pinned Matter.js version. Tests establish protocol behavior with that implementation, not Apple Home, Google Home, Home Assistant UI behavior, or compatibility with physical devices.

## Synthetic data and publication boundary

`seed.mjs` creates five bootstrap records from literals: synthetic Homey identity, a synthetic local owner, a root zone, and the power-user/virtual-device flags. The test password hash is generated locally. Nothing is copied from an activated Homey database or the private web-app/backend repositories. Device and pairing records are generated during each run.

Only source scripts, synthetic fixture definitions, image configuration and documentation belong in Git. `output/` is ignored; `tests/`, `scripts/`, `docs/` and `output/` are excluded from Homey app packages. Runtime device data lives in owned Docker volumes and controller storage in the temporary controller container.

The default image is `:latest` in `scripts/integration/config.mjs`, so new backend regressions surface without a pin update. After pulling, the runner uses the resolved immutable image ID for every container in that run. A retained lab keeps that image until `down` then `up`; device-control commands do not upgrade it midway through testing.

To reproduce a failure against the same backend, set `HOMEY_SHS_IMAGE` to a repository digest recorded in `result.json` (for example, `ghcr.io/athombv/homey-shs@sha256:…`). Explicit overrides are also pulled before starting. Backend bootstrap changes may require updating the synthetic seed schema.
