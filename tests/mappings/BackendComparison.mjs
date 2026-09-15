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

  async compare(fixture) {
    const source = this.#harness.devices[fixture.id];

    for (const expected of fixture.attributes) {
      const endpointId = this.#harness.endpoint(fixture.id, expected.endpoint);
      const clusterId = BridgeHarness.cluster(expected.cluster).id;
      const context = { fixture, expected, endpointId, clusterId };
      const capability = fixture.capabilities[expected.capabilityId];
      const isSetpoint = expected.cluster === 'Thermostat' && expected.name.includes('Setpoint');

      // Homey OS presents a single target whose meaning depends on the current mode.
      if (isSetpoint && source.capabilitiesObj.thermostat_mode) {
        const mode = expected.name.includes('Cooling') ? 'cool' : 'heat';
        source.emit('thermostat_mode', mode);
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
      if (expected.capabilityId === 'thermostat_mode') {
        source.emit('thermostat_mode', 'off');
        await this.#assertValue(context, 'off');
      }

      await this.#assertControl(context, capability.value);
    }
  }

  async #assertValue(context, input) {
    const { fixture, expected } = context;
    const { target, tolerance } = BackendComparison.#expectedValue(expected.capabilityId, input);

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

      const target = expected.capabilityId === 'light_temperature' ? 226 / 299 : input;
      assert.ok(
        Math.abs(actual - target) <= 0.01,
        `Backend requested ${actual}, expected ${target}`,
      );
    }, `${fixture.id}: backend control ${expected.capabilityId}`);
  }

  static #findCapability(snapshot, { fixture, expected, endpointId, clusterId }) {
    let capabilityId = expected.capabilityId;

    if (capabilityId === 'target_temperature.cool') {
      capabilityId = 'target_temperature';
    }
    // The bridge's Ultrasonic occupancy representation is named motion by Homey OS.
    if (capabilityId === 'alarm_occupancy') {
      capabilityId = 'alarm_motion';
    }

    for (const device of snapshot) {
      const capability = device.capabilities.find((item) => {
        const matchesEndpoint = item.endpointId === endpointId && item.clusterId === clusterId;
        const matchesName =
          item.id === capabilityId || item.id.startsWith(`${capabilityId}.matter-`);
        return matchesEndpoint && matchesName;
      });

      if (capability) {
        return { device, capability };
      }
    }

    throw new Error(`${fixture.id}: missing ${capabilityId} on ${endpointId}/${clusterId}`);
  }

  // These narrow allowances are documented in backend-allowances.json. Matter assertions stay exact.
  static #expectedValue(capabilityId, input) {
    switch (capabilityId) {
      case 'locked':
        return { target: input === null ? false : input, tolerance: 0 };
      case 'measure_temperature':
        return { target: input, tolerance: 0.05 };
      case 'measure_humidity':
        return { target: input, tolerance: 0.5 };
      case 'dim':
      case 'light_hue':
      case 'light_saturation':
        return { target: input, tolerance: 1 / 254 };
      case 'light_temperature': {
        // The pinned backend clamps the existing 1 mired minimum to 153.
        const target = new Map([
          [0.5, 0],
          [0, 0],
          [1, 1],
          [0.25, 0],
        ]).get(input);
        assert.notEqual(target, undefined, 'Unclassified color-temperature compatibility vector');
        return { target, tolerance: 1 / 147 };
      }
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
