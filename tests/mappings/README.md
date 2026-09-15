# Mapping contracts and backend comparison

The synthetic variants exercise all implemented official capability bases and bridge mapping families,
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

`mapping-names.test.mjs` verifies that Homey renames reach controller subscriptions without changing
endpoint identities, including persisted names after restart, delayed readiness, and re-enabling.
The source name controls the advertised Matter label; controller-specific display-name overrides
remain subject to that controller's naming rules.

The backend runs in a separate process with its own package resolution. The adapter executes its
real device interview and `MatterDevice.onSetCapabilityValue` handlers. Only the transport is
replaced. Reads, writes, commands, and subscription reports cross IPC as numeric paths and hex TLV
payloads. Explicit reads use the numeric protocol API on the commissioned peer, while
subscriptions own the controller endpoint cache (see the documented SDK structure race).
Matter.js decodes controller reports; their schema re-encodes values to TLV without unit
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
- Normalized light temperature uses the same 153–400 mired fallback as Homey OS (approximately
  6500–2500 K). Homey capabilities do not provide physical Kelvin limits, so this is a declared
  fallback rather than calibrated lamp metadata. Both directions now round-trip within one mired
  step (1/247); the previous backend clamp allowance has been removed.
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
It checks the fixture count and the installed official homey-lib catalog, plus the explicitly
verified Homey OS extensions in `../fixtures/homey-os-capabilities.json`. `matter_color_loop`,
`matter_mode_select`, and `open_lock` have definitions and handlers maintained by Homey OS, so they
are eligible for support. They remain missing mappings until their Matter behavior is implemented
and tested. Arbitrary app capabilities remain excluded.
Allowance reporting uses each attribute's comparison capability, including independent channels;
the source suffix does not hide a precision or naming allowance from the report.

When updating the reference, inspect the backend cluster and fixture changes, update the revision
and inventory deliberately, and rerun both suites. Do not automatically accept new expected values.
Missing features such as fan modes/oscillation, tariff/phase breakdowns, tamper alarms, and
robot-vacuum controls remain follow-up work; they are not silently marked supported by an endpoint smoke test.
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

The optional mutation command creates disposable source copies, seeds specific defects, and
requires a test failure with the expected assertion evidence. Syntax errors, timeouts, and unrelated
failures do not count as detection. Cases cover an unclassified attribute, a removed command contract,
power scaling, lock polarity, fractional setpoints, a missing subscription callback, stale restored
state, contradictory color modes, unknown booleans presented as known, inverted water alarms, and energy/battery/fan scaling. Logs and `mutations.json` stay in ignored artifacts. Run the
unmodified public suite first: mutation failures are meaningful only with a passing baseline.

### Controller command reliability

`mapping-command-reliability.test.mjs` independently verifies the commands beyond those normally sent
by Homey OS's capability handlers. The surface report names these tests and fails if their results
are absent or failing.

- Brightness and color move/step commands apply Matter's rate and bounds calculations to actual
  Homey writes. The first write is awaited; later failures stop the movement. Stop and device
  teardown cancel timers. Independent channels retain their full source capability IDs.
- Direct target fades retain native Homey duration options. Stop requests the currently reported
  source value with zero duration; physical accuracy during a native fade depends on the source's
  current-value reporting. The bridge does not have a separate Homey fade-cancellation capability.
- Scene recall forwards the sceneable on/off, brightness, saturation, mode and temperature fields.
  Homey errors reject recall. Ordinary hue is not a sceneable attribute in the current Matter model;
  this does not add EnhancedHue or claim to store hue values the model does not include.
- Identify advertises IdentifyType None. Its countdown and trigger-effect protocol are tested;
  no physical flashing or sound is claimed or synthesized.
- Optional timed unlocking is not advertised because the source has no native timed-unlock capability.
- A position-only cover rejects StopMotion explicitly; a state-only cover rejects absolute position.
  Covers with both capabilities can stop through `windowcoverings_state` and retain their endpoint.

These contracts complement the backend comparison. The backend only exercises
its own importer and capability handlers; another controller can use different advertised fields or
commands. Use [the physical checklist](PHYSICAL-CHECKS.md) for the controllers and devices available
to the tester. Passing synthetic tests cannot establish a physical platform's cache, UI, or behavior.


## Live-audit follow-up

Water alarms now use Water Leak Detector (0x0043) and Boolean State (0x0045): true means wet,
false means dry. Contracts cover single sensors and combined water/temperature devices. The
previous-release storage fixture stays unchanged; the new water endpoints initialize alongside
retained identities for existing mappings.

The selection screen explains unsupported and partially supported devices using source capability
titles. New selections with no supported capabilities are rejected before creating endpoints.
Existing unsupported selections remain visible and removable. API selection changes are serialized
so rapid additions cannot overwrite each other's saved selection; failed initialization is not saved.
The support classifier is checked against actual source subscriptions for every manifest variant.
Incomplete hue/saturation metadata retains basic light control and is shown as unshared color
capabilities; the bridge does not advertise an unusable Color Control cluster.

Matter occupancy, Boolean State, OnOff and smoke alarm fields cannot encode an unknown boolean.
For these mapped capabilities, null/non-boolean source readings retain the last attribute value and
set the bridged parent's Reachable attribute to false. This applies to the **whole bridged device**,
including other sensors on a mixed device. A known reading restores reachability only when Homey
also reports the device ready and available. Nullable numeric readings retain their existing null
representation. Initialization starts unreachable and refreshes source values before becoming
reachable. These guarantees are checked by `mapping-availability.test.mjs`, including restart.

`mapping-discovery.test.mjs` adds 50 synthetic devices to an already commissioned bridge and checks
complete descriptors, preserved existing identities and working subscriptions. It does not execute
Home Assistant's WebSocket client. See [controller observations](CONTROLLER-ISSUES.md) for the
separate event-ordering issue and the remaining physical-controller checks.

The bridge shares numeric CO₂/particulate readings, but the source has no corresponding qualitative
rating. Matter requires an Air Quality cluster for those sensor endpoints, so its rating remains
Unknown. The selection details explain this limitation; the bridge does not invent thresholds or
remove the required cluster to hide a controller's extra entity.


### Fan, energy and battery mappings

- Fans with official `fan_speed` expose Fan Control percentages. Custom fields such as
  `number.*_fan_speed` are excluded even if their range looks like a speed control. Their standard
  `onoff` capability remains shared. The supported
  sequence is Off/High, with percentages for intermediate speeds. Auto, oscillation and source
  `fan_mode` are not mapped. Off preserves the remembered source speed when an on/off capability
  exists; current Matter percentages become zero. Unknown source speed marks the device unavailable.
- Cumulative energy maps kWh to mWh (×1,000,000). `meter_power` takes precedence over
  `meter_power.imported`; `meter_power.exported` is independent. Daily and tariff counters are not
  added together. Values outside JavaScript's exact integer range after conversion become unknown.
  Contracts include 64-bit TLV values. Power in watts now works on other device classes too; existing
  socket power stays on its original endpoint. Supplemental readings use an Electrical Sensor
  endpoint with Tree Topology.
- `measure_battery` maps 0–100% to 0–200 with half-percent precision, clamping the limits and
  retaining null for unknown values. `alarm_battery` reports Warning/OK and replacement-needed
  without inventing a percentage. Both can coexist on one Power Source endpoint. The pinned
  backend imports the percentage preferentially and omits the alarm capability when both are
  present (`core/PowerSourceCluster.mts`); the public mixed-capability test checks both Matter
  attributes independently. No battery chemistry, capacity or replacement type is inferred.

`mapping-fan.test.mjs` and `mapping-power.test.mjs` check additions to already paired devices,
retained parent/child endpoint numbers, fan commands, unsupported requests, unknown
readings, numeric limits, and independent battery percentage/alarm values. The pinned Power Source
server batches battery reports, so only those subscription assertions allow a 15-second wait.
The backend report records imported-total naming, official fan speed, and quantization
allowances. Homey OS rounds energy totals to three decimals in kWh; only the backend
comparison allows half that display step, while Matter assertions retain exact mWh. These rules do not relax the independent Matter assertions.

### Light range and transition regressions

`mapping-light-controls.test.mjs` checks realistic normalized color-temperature limits, round-trip
commands and restart identity. Brightness and combined hue/saturation or temperature commands
forward Matter deciseconds as Homey `opts.duration` milliseconds, including zero and the default
level transition. Source drivers remain responsible for executing the requested fade. Rejected
commands still fail at the Matter boundary. Mutation checks independently break the range and
duration conversion.


### Official capabilities and independent channels

`tests/fixtures/official-capabilities.json` records the implemented bases from homey-lib 2.52.2
installed with the pinned backend, including source paths and reference revision. Coverage validation
permits bases from this catalog and the verified Homey OS extensions recorded separately in
`tests/fixtures/homey-os-capabilities.json`. Eligibility does not imply that a mapping exists;
declared support still requires behavioral contracts. Custom app fields, including generic
`number.*`, `boolean.*`, and vendor-specific bases, are excluded.

PM1 uses the numeric PM1 Concentration Measurement cluster in µg/m³. Voltage and current use
Electrical Power Measurement in mV and mA. Wrong units, nonnumeric metadata and write-only metadata
for these three readings are excluded. Zero, fractional and unknown values have independent contracts.
Electrical Power Measurement requires `activePower`; it stays null when no power capability exists.
Homey OS may therefore reconstruct an additional unknown power capability for a voltage/current-only
endpoint. It also rounds voltage/current to two decimals; the narrow backend allowance does not
change the exact Matter assertions.

For implemented bases, matching suffixes form independent channels: `onoff.secondary` and
`dim.secondary` control the same light channel, with writes sent to their full original capability IDs.
Measurement-only channels do not inherit unrelated light/thermostat controls. Unsuffixed endpoints
keep their existing IDs; added channels use stable IDs derived from the complete suffix. No phase,
app-specific semantics or conversion is inferred from a suffix. Sub-capabilities retain the same
class, feature and capability-combination requirements as their base mappings.

The existing `target_temperature.cool` alongside `thermostat_mode` remains a separate cooling target.
Energy totals retain their established `meter_power`, `.imported` and `.exported` rules. Other energy
suffixes remain unshared: names do not establish direction, reset periods or non-overlapping totals.
The backend reconstructs its own endpoint-derived suffixes; comparisons match endpoint/cluster and
official base rather than requiring original Homey suffix text. It may synthesize a combined power
reading for sibling electrical endpoints; per-channel comparisons must use the physical endpoint's
own capability and must not treat the combined value as a channel reading.

`mapping-channels.test.mjs` checks mixed channels, exact source writes, read-only rejection,
measurement-only channels, unknown booleans, restart identity, re-enabling and subscription cleanup.
The main manifest exercises all mapped sensor bases and representative controls with suffixes,
including a mixed electrical device with multiple readings on each channel.
`fan-policy-upgrade.json` contains only disposable synthetic pairing state produced by
`generate-fan-upgrade-fixture.mjs` using the previous bridge commit. The upgrade test verifies that
removing custom fan speed preserves the existing on/off endpoint and pairing.
