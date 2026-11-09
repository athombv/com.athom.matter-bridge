# Testing the installed app against Homey SHS

This suite packages and installs the app in a disposable Homey Self-Hosted Server (SHS), creates backend-managed devices through Homey's pairing API, and commissions a Matter.js controller over UDP/mDNS. It exercises the Homey SDK, homey-api subscriptions, app HTTP routes, persisted Matter endpoints, and the protocol in both directions. No bridge internals or mocked capability subscriptions are used.

## Requirements and first run

Use Linux with a local Docker Engine, Node.js 22.20 or newer, and Homey CLI 4.4.4. The SHS container requires privileged mode. Docker Desktop and remote Docker daemons are not currently verified; the runner uses local bind mounts and IPv6 Docker networking.

```sh
npm ci
npm install --global homey@4.4.4
npm run test:integration
```

No Athom account, Homey CLI login, physical Homey, real devices, activation backup, private repository, or repository secrets are needed. The first run pulls the pinned public SHS image. Subsequent runs reuse the image cache. Each run builds the current working tree, including local source edits and untracked source files not excluded by Git, in a temporary staging directory. The production checkout and its dependencies are not modified by packaging.

The default smoke scenario checks:

- Native SHS virtual light and socket creation and sharing through the installed app.
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
npm run shs -- logs
npm run shs -- down
```

`up` installs the current app and creates two shared devices, `Lab light` and `Lab socket`. It prints a dynamically allocated loopback HTTP address. The synthetic local login is `bridge-test` / `bridge-test`; these are public test-only credentials. CLI commands reuse an ephemeral session in ignored `output/integration/<run>/session.json` to avoid repeated-login rate limits. The session file is excluded from CI artifact uploads. A web app supporting local SHS login can use that address. The runner does not include or require the private Homey web app.

`set` accepts a device name or ID and a JSON capability value. It talks only to this runner's disposable backend. `logs` follows complete timestamped SHS/app stdout and stderr. `down` saves the logs and removes the lab and its data. A second `up` refuses to overwrite a running lab; use `down` then `up` to install new source changes.

The HTTP port is loopback-only. SHS remains on an internal Docker network with no outbound route; a fixed-destination proxy exposes only its HTTP service. The Matter controller used by tests shares the SHS network namespace. This lab is intended for local software testing; it does not advertise a bridge to physical controllers on the household LAN.

## Verify a branch or regression

The test harness remains from this checkout while `--ref` selects which version of the app to package. This lets a new regression test demonstrate a failure before a fix and success after it, without cherry-picking the harness into both branches.

```sh
# Run the smoke scenario against a Git ref.
npm run test:integration -- --ref origin/master

# The re-sharing regression should fail on master before #40.
npm run test:integration -- --scenario reshare --ref origin/master

# Fetch #40, then run exactly the same scenario against its app code.
git fetch origin pull/40/head:refs/remotes/origin/pr-40
npm run test:integration -- --scenario reshare --ref origin/pr-40

# A persistent lab can also install an arbitrary ref.
npm run shs -- up --ref origin/pr-40
```

`reshare` repeats removal/recreation three times, writes state while unshared, exercises repeated enable/disable calls, and verifies live updates, dimming, unchanged control-device identity, push reports on the original subscription, and commands back to SHS. It is explicit rather than part of the default smoke scenario because it reproduces the known failure on master before #40. It is not skipped or treated as an expected pass: a regression failure exits nonzero. Add it to the CI/default suite when that fix lands.

Stored initial state after recreation is a separate concern from live updates (see #33). The regression prints the observed initial state, synchronizes both sides, and then demands fresh subscription reports for actual value transitions. Matter does not owe a change report for writing a value it already has.

## Reports and troubleshooting

Each run prints its directory under ignored `output/integration/`. It contains:

- `result.json`: outcome, source commit/ref, dirty-worktree flag, image digest and timestamps.
- `results.xml` and `tests.log`: JUnit and TAP results, including assertion failures.
- `build.log` and `setup.log`: packaging and installation output.
- `homey-shs.log`: complete timestamped SHS and app stdout/stderr, including startup.

The `SHS Integration` GitHub workflow runs the default scenario on relevant pull requests and manual dispatch, and uploads reports/logs even on failure. It uses the same runner and image as local testing. CI needs no secrets. The workflow itself must run in GitHub before its hosted execution can be considered verified.

SHS logs may include failed cloud, weather, update and outbound-IP requests because the backend is deliberately offline. Test success is based on device and protocol assertions, not an empty error log. Logs and protocol artifacts may contain ephemeral test tokens or pairing codes; keep them in ignored output or short-lived CI artifacts.

SIGKILL or host failure cannot run cleanup. Docker resources are labeled `matter-bridge.integration` with a checkout-specific owner value. Inspect those labels before manually deleting interrupted runs; never use a global Docker prune for this workflow. A retained manual lab also has an ignored `output/integration/lab.json` manifest for `down`.

## Extend the suite

Device definitions live in `tests/integration/support/devices.mjs`. They specify Homey class, capabilities and initial values; `HomeyClient.createDevice()` creates real backend state using the native virtual driver. Add an appropriate fixture definition when testing another mapping. Hardware-specific driver behavior still requires physical-device testing.

`createBridge(t)` owns device and controller teardown. `HomeyClient` handles backend operations; `MatterController` handles discovery, wire reads, push reports and commands. Scenarios use Node's built-in test runner. Register a new scenario name in `scripts/integration/run.mjs` and add `tests/integration/<name>.test.mjs`; keep cases independent and use bounded condition polling instead of fixed sleeps.

The app and controller currently use the same pinned Matter.js version. Tests establish protocol behavior with that implementation, not Apple Home, Google Home, Home Assistant UI behavior, or compatibility with physical devices.

## Synthetic data and publication boundary

`seed.mjs` creates five bootstrap records from literals: synthetic Homey identity, a synthetic local owner, a root zone, and the power-user/virtual-device flags. The test password hash is generated locally. Nothing is copied from an activated Homey database or the private web-app/backend repositories. Device and pairing records are generated during each run.

Only source scripts, synthetic fixture definitions, the image digest and documentation belong in Git. `output/` is ignored; `tests/`, `scripts/`, `docs/` and `output/` are excluded from Homey app packages. Runtime device data lives in owned Docker volumes and controller storage in the temporary controller container.

The default SHS 13.4.1 image is pinned in `scripts/integration/config.mjs`. Override `HOMEY_SHS_IMAGE` only for an intentional compatibility run. Update the pin and seed schema together when adopting a backend version that changes its bootstrap contract.
