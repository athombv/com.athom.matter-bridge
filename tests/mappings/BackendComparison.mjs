import assert from 'node:assert/strict';
import { BridgeHarness } from './BridgeHarness.mjs';
import { eventually } from './eventually.mjs';

export class BackendComparison {
  #harness;
  #rpc;

  constructor(harness, rpc) {
    this.#harness = harness;
    this.#rpc = rpc;
  }

  static applicableAllowances(fixture, allowances) {
    const capabilities = new Set();

    for (const expected of fixture.attributes) {
      capabilities.add(expected.backendCapability ?? expected.capabilityId);
    }

    const applicable = [];

    for (const allowance of allowances) {
      const matches = allowance.capabilities.some((id) => {
        return capabilities.has(id);
      });

      if (matches) {
        applicable.push(allowance.id);
      }
    }

    return applicable;
  }

  async compare(fixture) {
    const source = this.#harness.devices[fixture.id];
    const modeId = fixture.capabilitySuffix ? `thermostat_mode.${fixture.capabilitySuffix}` : 'thermostat_mode';

    for (const expected of fixture.attributes) {
      const endpointId = this.#harness.endpoint(fixture.id, expected.endpoint);
      const clusterId = BridgeHarness.cluster(expected.cluster).id;
      const context = { fixture, expected, endpointId, clusterId };
      const capability = fixture.capabilities[expected.capabilityId];
      const isSetpoint = expected.cluster === 'Thermostat' && expected.name.includes('Setpoint');

      // Homey OS presents a single target whose meaning depends on the current mode.
      if (isSetpoint && source.capabilitiesObj[modeId]) {
        const mode = expected.name.includes('Cooling') ? 'cool' : 'heat';
        source.emit(modeId, mode);
        await this.#harness.expectReport(
          endpointId,
          'Thermostat',
          'systemMode',
          mode === 'cool' ? 3 : 4,
        );
      }

      // An earlier command may have changed a shared target; restore this vector explicitly.
      source.emit(expected.capabilityId, capability.value);
      await this.#assertValue(context, capability.value);

      for (const [input, output] of expected.updates) {
        source.emit(expected.capabilityId, input);
        await this.#harness.expectReport(endpointId, expected.cluster, expected.name, output);
        await this.#assertValue(context, input);
      }

      if (!capability.setable || capability.value === null) {
        continue;
      }

      // A redundant attribute write can legitimately avoid issuing a Homey command.
      if (expected.capabilityId === modeId) {
        source.emit(modeId, 'off');
        await this.#assertValue(context, 'off');
      }

      await this.#assertControl(context, capability.value);
    }
  }

  async #assertValue(context, input) {
    const { fixture, expected } = context;
    const { target, tolerance } = BackendComparison.#expectedValue(
      expected.backendCapability ?? expected.capabilityId, input,
    );

    await eventually(async () => {
      const snapshot = await this.#rpc.call('snapshot');
      const { capability } = BackendComparison.#findCapability(snapshot, context);
      const description = `${fixture.id}/${expected.capabilityId}`;

      if (typeof target !== 'number') {
        assert.deepEqual(capability.value, target, description);
        return;
      }

      assert.equal(typeof capability.value, 'number', `${description}: numeric value`);
      assert.ok(
        Math.abs(capability.value - target) <= tolerance + 1e-9,
        `${description}: expected ${target} ± ${tolerance}, got ${capability.value}`,
      );
    }, `${fixture.id}: backend value for ${expected.capabilityId}`);
  }

  async #assertControl(context, input) {
    const { fixture, expected } = context;
    const source = this.#harness.devices[fixture.id];
    const snapshot = await this.#rpc.call('snapshot');
    const { device, capability } = BackendComparison.#findCapability(snapshot, context);

    source.writes.length = 0;
    await this.#rpc.call('set', { deviceId: device.id, capabilityId: capability.id, value: input });

    await eventually(() => {
      const writes = source.writes.filter((write) => {
        return write.capabilityId === expected.capabilityId;
      });

      assert.ok(writes.length, `Backend command did not reach ${expected.capabilityId}`);

      const actual = writes.at(-1).value;
      if (typeof input !== 'number') {
        assert.deepEqual(actual, input);
        return;
      }

      const target = input;
      assert.ok(
        Math.abs(actual - target) <= 0.01,
        `Backend requested ${actual}, expected ${target}`,
      );
    }, `${fixture.id}: backend control ${expected.capabilityId}`);
  }

  static #findCapability(snapshot, { fixture, expected, endpointId, clusterId }) {
    let capabilityId = expected.backendCapability ?? expected.capabilityId;

    if (capabilityId === 'meter_power.imported') {
      capabilityId = 'meter_power';
    }

    if (capabilityId === 'target_temperature.cool') {
      capabilityId = 'target_temperature';
    }
    // The bridge's Ultrasonic occupancy representation is named motion by Homey OS.
    if (capabilityId === 'alarm_occupancy') {
      capabilityId = 'alarm_motion';
    }

    const separator = capabilityId.includes('.') ? '-' : '.';
    const endpointCapabilityId = `${capabilityId}${separator}matter-${endpointId}-${clusterId}`;

    for (const device of snapshot) {
      let candidates = device.capabilities.filter((item) => {
        const matchesEndpoint = item.endpointId === endpointId && item.clusterId === clusterId;
        const matchesName = item.id === capabilityId || item.id === endpointCapabilityId;
        return matchesEndpoint && matchesName;
      });

      // The backend adds an aggregate power capability to the first sibling's metadata.
      // Compare the physical channel, never that sum, when both coexist on this endpoint.
      if (capabilityId === 'measure_power' && clusterId === 144 && candidates.length === 2) {
        candidates = candidates.filter((item) => {
          return item.id === endpointCapabilityId;
        });
      }
      assert.ok(candidates.length <= 1, `${fixture.id}: ambiguous backend capability ${capabilityId}`);

      if (candidates.length) {
        return { device, capability: candidates[0] };
      }
    }

    throw new Error(`${fixture.id}: missing ${capabilityId} on ${endpointId}/${clusterId}`);
  }

  // These narrow allowances are documented in backend-allowances.json. Matter assertions stay exact.
  static #expectedValue(capabilityId, input) {
    switch (capabilityId) {
      case 'meter_power':
      case 'meter_power.imported':
      case 'meter_power.exported':
        return { target: input, tolerance: 0.0005 };
      case 'fan_speed':
        return { target: input, tolerance: 0.005 };
      case 'measure_battery':
        return { target: input, tolerance: 0.5 };
      case 'locked':
        return { target: input === null ? false : input, tolerance: 0 };
      case 'measure_voltage':
      case 'measure_current':
        return { target: input, tolerance: 0.005 };
      case 'measure_temperature':
        return { target: input, tolerance: 0.05 };
      case 'measure_humidity':
        return { target: input, tolerance: 0.5 };
      case 'dim':
      case 'light_hue':
      case 'light_saturation':
        return { target: input, tolerance: 1 / 254 };
      case 'light_temperature':
        return { target: input, tolerance: 1 / 247 };
      case 'windowcoverings_set':
        return { target: input, tolerance: 0.005 };
      case 'measure_luminance':
        // The backend applies its logarithmic formula to Matter's special zero value too.
        return { target: input === 0 ? 10 ** (-1 / 10000) : input, tolerance: 0.001 };
      default:
        return { target: input, tolerance: 0 };
    }
  }
}
