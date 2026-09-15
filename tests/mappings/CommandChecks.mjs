import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { eventually } from './eventually.mjs';

export class CommandChecks {
  #harness;
  #fixture;

  constructor(harness, fixture) {
    this.#harness = harness;
    this.#fixture = fixture;
  }

  async run(operation, { reject = false } = {}) {
    const harness = this.#harness;
    const fixture = this.#fixture;
    const device = harness.devices[fixture.id];
    const values = Object.fromEntries(
      Object.entries(fixture.capabilities).map(([id, capability]) => {
        return [id, capability.value];
      }),
    );
    Object.assign(values, operation.prepare);
    for (const [id, desired] of Object.entries(operation.writes)) {
      if (!isDeepStrictEqual(values[id], desired)) {
        continue;
      }
      const contract = fixture.attributes.find((attribute) => {
        return attribute.capabilityId === id;
      });
      const alternative = contract.updates.find(([value]) => {
        return value !== null && !isDeepStrictEqual(value, desired);
      });
      assert.ok(alternative, `No non-redundant command preparation for ${fixture.id}/${id}`);
      values[id] = alternative[0];
    }
    // Toggle has a deliberate start state independent of earlier commands.
    if (operation.name === 'toggle') {
      values.onoff = true;
    }
    for (const [id, value] of Object.entries(values)) {
      device.emit(id, value);
    }
    for (const attribute of fixture.attributes) {
      const value = values[attribute.capabilityId];
      let expected = attribute.initial;
      if (!isDeepStrictEqual(value, fixture.capabilities[attribute.capabilityId].value)) {
        const vector = attribute.updates.find(([input]) => {
          return isDeepStrictEqual(input, value);
        });
        assert.ok(vector, `No preparation vector for ${fixture.id}/${attribute.name}`);
        expected = vector[1];
      }
      if (values.onoff === false && 'valueWhenOff' in attribute) {
        expected = attribute.valueWhenOff;
      }
      await harness.expectReport(
        harness.endpoint(fixture.id, attribute.endpoint),
        attribute.cluster,
        attribute.name,
        expected,
      );
    }
    const before = [];
    for (const attribute of fixture.attributes) {
      before.push(
        await harness.read(
          harness.endpoint(fixture.id, attribute.endpoint),
          attribute.cluster,
          attribute.name,
        ),
      );
    }
    device.writes.length = 0;
    const attempts = device.attempts;
    const endpoint = harness.endpoint(fixture.id, operation.endpoint);
    const execute = async () => {
      if (operation.attribute) {
        await harness.write(endpoint, operation.cluster, operation.attribute, operation.value);
      } else {
        await harness.invoke(endpoint, operation.cluster, operation.name, operation.fields);
      }
    };

    if (reject) {
      device.rejectWrites = true;
      try {
        await assert.rejects(execute);
        assert.ok(device.attempts > attempts, 'Failure must come from the simulated source');
        assert.deepEqual(device.writes, []);
        for (const [index, attribute] of fixture.attributes.entries()) {
          assert.deepEqual(
            await harness.read(
              harness.endpoint(fixture.id, attribute.endpoint),
              attribute.cluster,
              attribute.name,
            ),
            before[index],
            `Rejected ${operation.name ?? operation.attribute} changed ${attribute.cluster}.${attribute.name}`,
          );
        }
      } finally {
        device.rejectWrites = false;
      }
      return;
    }

    await execute();
    await eventually(
      () => {
        const actual = Object.fromEntries(
          device.writes.map((write) => {
            return [write.capabilityId, write.value];
          }),
        );
        assert.deepEqual(actual, operation.writes);
      },
      `${fixture.id}: Homey writes for ${operation.name ?? operation.attribute}`,
    );

    const outcomes = CommandChecks.outcomes(fixture, operation);
    for (const [cluster, name, expected] of outcomes) {
      await harness.expectReport(endpoint, cluster, name, expected);
      assert.deepEqual(await harness.read(endpoint, cluster, name), expected);
    }
    // A command must preserve unrelated mapped state, including sibling sensor endpoints.
    for (const [index, attribute] of fixture.attributes.entries()) {
      const attributeEndpoint = harness.endpoint(fixture.id, attribute.endpoint);
      const outcome = outcomes.find(([cluster, name]) => {
        return (
          attributeEndpoint === endpoint && cluster === attribute.cluster && name === attribute.name
        );
      });
      const expected = outcome ? outcome[2] : before[index];
      await harness.expectReport(attributeEndpoint, attribute.cluster, attribute.name, expected);
      assert.deepEqual(
        await harness.read(attributeEndpoint, attribute.cluster, attribute.name),
        expected,
        `${operation.name ?? operation.attribute} changed unrelated ${attribute.cluster}.${attribute.name}`,
      );
    }
  }

  static outcomes(fixture, operation) {
    if (operation.outcomes) {
      return operation.outcomes;
    }
    if (operation.attribute) {
      const result = [[operation.cluster, operation.attribute, operation.value]];
      const sharedSetpoint =
        operation.attribute.includes('Setpoint') &&
        !fixture.capabilities['target_temperature.cool'];
      if (sharedSetpoint) {
        for (const attribute of fixture.attributes) {
          if (
            attribute.cluster === 'Thermostat' &&
            attribute.name.includes('Setpoint') &&
            attribute.name !== operation.attribute
          ) {
            result.push(['Thermostat', attribute.name, operation.value]);
          }
        }
      }
      return result;
    }
    switch (operation.cluster) {
      case 'OnOff':
        return [['OnOff', 'onOff', operation.writes.onoff]];
      case 'LevelControl': {
        const result = [
          [
            'LevelControl',
            'currentLevel',
            operation.fields.level === 0 ? 1 : operation.fields.level,
          ],
        ];
        if (operation.name === 'moveToLevelWithOnOff') {
          result.push(['OnOff', 'onOff', operation.writes.onoff]);
        }
        return result;
      }
      case 'ColorControl': {
        const mode = operation.name === 'moveToColorTemperature' ? 2 : 0;
        const result = [
          ['OnOff', 'onOff', true],
          ['ColorControl', 'colorMode', mode],
          ['ColorControl', 'enhancedColorMode', mode],
        ];
        if (mode === 2) {
          result.push([
            'ColorControl',
            'colorTemperatureMireds',
            operation.fields.colorTemperatureMireds,
          ]);
        } else {
          result.push(
            ['ColorControl', 'currentHue', operation.fields.hue],
            ['ColorControl', 'currentSaturation', operation.fields.saturation],
          );
        }
        return result;
      }
      case 'Thermostat': {
        const result = [];
        for (const attribute of fixture.attributes) {
          if (
            !(attribute.capabilityId in operation.writes) ||
            !attribute.name.includes('Setpoint')
          ) {
            continue;
          }
          const expected = operation.writes[attribute.capabilityId] === 24 ? 2400 : 2100;
          assert.ok(
            [21, 24].includes(operation.writes[attribute.capabilityId]),
            'New setpoint command needs an independent outcome',
          );
          result.push(['Thermostat', attribute.name, expected]);
        }
        return result;
      }
      case 'DoorLock':
        return [['DoorLock', 'lockState', operation.writes.locked ? 1 : 2]];
      case 'WindowCovering': {
        if ('windowcoverings_state' in operation.writes) {
          const movement = { up: 1, down: 2, idle: 0 }[operation.writes.windowcoverings_state];
          return [
            ['WindowCovering', 'operationalStatus', { global: movement, lift: movement, tilt: 0 }],
          ];
        }
        let position = operation.fields.liftPercent100thsValue;
        if (operation.name === 'upOrOpen') {
          position = 0;
        }
        if (operation.name === 'downOrClose') {
          position = 10000;
        }
        return [
          ['WindowCovering', 'currentPositionLiftPercent100ths', position],
          ['WindowCovering', 'targetPositionLiftPercent100ths', position],
        ];
      }
      default:
        throw new Error(
          `No independent command outcome for ${operation.cluster}/${operation.name}`,
        );
    }
  }
}
