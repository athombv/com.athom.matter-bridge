# Mapping contracts and backend comparison

The 38 synthetic variants exercise 24 Homey capabilities, all existing bridge mapping families,
class aliases, and virtual classes. These are behavioral contracts, not generated snapshots of
whatever the bridge currently happens to expose. Numeric Matter expectations do not use production
conversion helpers. `manifest.mjs` records expected device types, exact cluster sets, selected
feature maps for every advertised cluster, units and limits, startup values, subscription transitions,
commands, and attribute writes.

## Commands

Run the public suite with Node 22:

```sh
npm run test:mappings
npm test
npm run test:mappings:report
npm run test:mappings:mutations
```

The report command runs the tests and writes `tests/mappings/artifacts/report.md`, including actual
PASS/FAIL/NOT RUN results and the capability inventory. Generated artifacts are ignored by Git.
`npm test` also includes pairing, migration, settings, and Homey API tests.

For a focused diagnostic run, set `MAPPING_CASE=socket` or a comma-separated list of fixture IDs.
Normal CI and acceptance runs must leave this variable unset.

Run the optional backend comparison from this repository:

```sh
npm run test:mappings:backend -- \
  --backend-path /path/to/node-homey-os \
  --backend-node /path/to/node24
```

Install the backend's dependencies using its own documented setup first. The adapter requires Node
24 and a clean tracked checkout at `bafec2787531c8065e49622a73ed6a42f23b3669`.
`--allow-backend-revision-mismatch` explicitly permits an exploratory run against another revision
or modified checkout; the result records that fact. It does not change the stored reference.
Public CI does not require backend access, private dependencies, or Node 24.

## What runs

The test code has separate responsibilities:

- `SimulatedDevice.mjs` owns source device state, subscriptions, writes, and failures.
- `BridgeHarness.mjs` owns the bridge/controller lifecycle and Matter reads, writes, and commands.
- `BridgeTransport.mjs` forwards protocol requests and reports across the process boundary.
- `BackendComparison.mjs` checks reconstructed capabilities and the documented value allowances.
- `Rpc.mjs` owns request/reply coordination, disconnect handling, and remote error causes.

The infrastructure tests exercise disconnects, failed sends, cleanup failures, and invalid fixture
selection. The report command includes these tests alongside the mapping contracts and inventory.

`BridgeHarness` commissions an actual `MatterBridgeServer` with a disposable Matter.js controller.
Simulated Homey devices retain callbacks, report state changes, record writes, and reject commands.
Assertions inspect controller reads and subscription reports, not just server objects. Lifecycle
checks cover delayed readiness, subscription disposal on disable/shutdown, re-enabling, and control
with existing controller credentials after restart.

The backend runs in a separate process with its own package resolution. The adapter executes its
real device interview and `MatterDevice.onSetCapabilityValue` handlers. Only the transport is
replaced. Reads, writes, commands, and subscription reports cross IPC as numeric paths and hex TLV
payloads. Matter.js decodes controller reports; their schema re-encodes values to TLV without unit
conversion or JSON number coercion. List assembly is handled by Matter.js. This is lossless for
modeled attribute values, not a byte-for-byte network packet capture.

Backend matching uses capability provenance (endpoint and cluster), with explicit treatment of
endpoint suffixes and grouping. The adapter supplies no missing device types, features, or attribute
values. Test state is temporary; no daemon, real Homey, or existing pairing is used. The worker and
all mapping fixtures live under the already excluded `tests/` packaging directory.

## Pinned backend differences

These are compatibility observations, not permission to loosen the public Matter contracts:

- Brightness, hue, and saturation have Matter quantization; comparisons allow one encoded step.
- Homey rounds temperatures to tenths and cover positions to hundredths. The backend comparison
  allows half a Homey step; public tests assert exact Matter integers.
- The backend presents heating/cooling through a mode-dependent `target_temperature`. Separate
  cooling targets are tested after selecting cooling; a redundant mode write is avoided by first
  selecting off.
- The bridge's existing Ultrasonic occupancy representation is named `alarm_motion` by the backend.
  The comparison checks identical boolean meaning and records the name difference.
- `ColorControlCluster.mts` clamps a physical minimum below 100 mired to 153. The bridge's existing
  1–300 mired range therefore loses its lower range on import. Explicit vectors verify that Homey
  inputs 0, 0.25, and 0.5 import as 0, and 1 imports as 1. A backend command of 0.5 produces 227 mired,
  corresponding to 226/299 in the source. Changing this established range is separate product work.
- `DoorLockCluster.mts` maps a null lock state to `false`. The adapter checks this specific backend
  behavior; public tests require the bridge to preserve unknown lock state as null.
- `MeasurementClusters.mts` applies the illuminance logarithm to the special Matter value 0. The
  backend reports approximately 1 lux; the independent bridge assertion remains exactly 0.

`backend-allowances.json` records the precise rules and source paths. The backend result includes
these entries and identifies which apply to each variant in `tests/mappings/artifacts/backend.json`.
A passing comparison means
there are no unexplained differences for these cases, not universal controller compatibility or
Matter certification. Physical-platform and CHIP Tool testing remain separate.

## Maintaining coverage

`backend-inventory.json` records capabilities observed in 72 backend saved-device fixtures, plus
current mappings evidenced by the cluster library. It contains names and provenance, not copied
customer device JSON. It is not an exhaustive catalog of all Homey or Matter capabilities.

Every inventory entry is supported, missing, or intentionally unsupported with a reason. Declared
support requires initial/update contracts and control contracts for writable capabilities. Required
variant IDs prevent silently deleting coverage while retaining a capability elsewhere. The local
backend command also scans its saved output fixtures and fails on newly unclassified capabilities.

When updating the reference, inspect the backend cluster and fixture changes, update the revision
and inventory deliberately, and rerun both suites. Do not automatically accept new expected values.
Missing features such as water alarms, battery reporting, fans, energy counters, and robot-vacuum
controls remain follow-up work; they are not silently marked supported by an endpoint smoke test.
The report also records feature gaps: custom OnOff handlers advertise basic on/off without the
Lighting or room AC DeadFrontBehavior bits. Continuous level/color movement, scenes, and timed
lighting need their own command contracts before support is claimed. Passing this suite does not
establish complete device-type conformance.

## Independent protocol audit

`matter-surface.json` explicitly classifies attributes and accepted commands actually advertised by
bridged parent and child endpoints. `SurfaceAudit.mjs` fails when an advertised member has no
classification, or a member declared tested has no mapping assertion or invariant. It also checks
parent metadata, exact descriptor relationships and features, both color modes, color capability
bits, thermostat mode/limit relationships, cover status, sensor bounds, and other related values.
The catalog is deliberately reviewed; it must not be regenerated to accept new bridge output.

The report distinguishes tested members, behavior delegated to the pinned SDK with a reason, and
explicit gaps. These counts represent cluster members, including separate cover capability contexts;
they are not device counts or a percentage of Matter conformance. Generated responses, events,
SDK configuration writes, root commissioning, and aggregator internals are outside this application
surface audit. Root pairing/migration has separate tests. Delegating SDK behavior does not verify
that a physical Homey device responds to it.

`CommandChecks.mjs` checks source writes and resulting controller reads/subscriptions for every
mapping command and mapped attribute write. It resets source state between cases and forces a real
change so a no-op cannot masquerade as a successful command. Every operation is also tested with
source writes rejected: it must return a failure, attempt a source write, and leave mapped values
unchanged. This covers rejection of the whole operation, not partial success where one of several
Homey capability writes succeeds before another fails. Transition timing and those partial failures
remain follow-up work.

`mapping-upgrade.test.mjs` exercises all variants twice: across a current-version restart, and from
synthetic storage written by the actual previous release. It persists changes before stopping,
changes source values while offline, and reconnects using retained controller credentials. See
`../fixtures/README.md` for provenance and the controller-cache limitation. The bridge refreshes
source values after endpoint restoration using the same callbacks as subsequent subscriptions.

The optional mutation command creates disposable source copies, seeds eight specific defects, and
requires a test failure with the expected assertion evidence. Syntax errors, timeouts, and unrelated
failures do not count as detection. Cases cover an unclassified attribute, a removed command contract,
power scaling, lock polarity, fractional setpoints, a missing subscription callback, stale restored
state, and contradictory color modes. Logs and `mutations.json` stay in ignored artifacts. Run the
unmodified public suite first: mutation failures are meaningful only with a passing baseline.

### Remaining advertised command gaps

The inventory keeps these visible without treating a passing backend comparison as evidence:

- Identify and trigger-effect commands have no verified physical identification behavior.
- Scene recall has no contract proving that stored state reaches Homey.
- Continuous/step/stop brightness and color commands lack independent source-control contracts.
- Timed unlocking has no verified source-control contract.
- Position-only covers have no source stop capability; state-only covers have no absolute position
  capability. These need explicit behavior decisions for inherited stop/percentage commands.

These are coverage gaps, not a claim that every listed command is defective. They must be resolved
or explicitly accepted as release limitations before claiming support. The backend only exercises
its own importer and capability handlers; another controller can use different advertised fields or
commands. Use [the physical checklist](PHYSICAL-CHECKS.md) for the controllers and devices available
to the tester. Passing synthetic tests cannot establish a physical platform's cache, UI, or behavior.
