import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { SimulatedDevice } from './mappings/SimulatedDevice.mjs';

const socket = {
  id: 'existing-socket', class: 'socket',
  capabilities: { onoff: { value: true, setable: true }, measure_power: { value: 1.25 } },
};

test('bulk additions expose complete descriptors and working subscriptions', { timeout: 60000 }, async (t) => {
  const harness = await BridgeHarness.create([socket]);
  t.after(async () => {
    await harness.close();
  });
  const existing = harness.endpoint(socket.id);
  const additions = [];

  for (let index = 0; index < 50; index++) {
    const fixture = index % 2 === 0
      ? { ...socket, id: `added-socket-${index}` }
      : {
          id: `added-water-${index}`, class: 'sensor',
          capabilities: { alarm_water: { value: false }, measure_temperature: { value: 21.25 } },
        };
    const device = new SimulatedDevice(fixture);
    harness.devices[device.id] = device;
    additions.push(device);
    await harness.bridge.enableDevice(device.id);
  }

  assert.equal(harness.endpoint(socket.id), existing, 'Existing endpoint identity is preserved');
  const parents = [];

  for (const device of additions) {
    const parent = harness.bridge.deviceEndpoints[device.id].number;
    parents.push(parent);
    const children = await harness.read(parent, 'Descriptor', 'partsList');
    assert.equal(children.length, device.class === 'socket' ? 1 : 2);
    assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'reachable'), true);

    for (const child of children) {
      const clusters = await harness.read(child, 'Descriptor', 'serverList');
      assert.ok(clusters.includes(29), 'Every child has a Descriptor cluster');
      assert.equal((await harness.read(child, 'Descriptor', 'deviceTypeList')).length, 1);
    }

    if (device.class === 'socket') {
      const endpoint = harness.endpoint(device.id);
      assert.equal(await harness.read(endpoint, 'ElectricalPowerMeasurement', 'activePower'), 1250);
      device.emit('measure_power', 2.5);
      await harness.expectReport(endpoint, 'ElectricalPowerMeasurement', 'activePower', 2500);
    } else {
      const endpoint = harness.endpoint(device.id, 'alarm_water');
      assert.equal(await harness.read(endpoint, 'BooleanState', 'stateValue'), false);
      device.emit('alarm_water', true);
      await harness.expectReport(endpoint, 'BooleanState', 'stateValue', true);
    }
  }

  assert.equal(new Set(parents).size, additions.length);
  const parts = await harness.read(harness.bridge.aggregatorEndpoint.number, 'Descriptor', 'partsList');

  for (const parent of parents) {
    assert.ok(parts.includes(parent), 'Aggregator advertises every added parent');
  }

  const unsupported = new SimulatedDevice({
    id: 'unsupported-camera', class: 'camera', capabilities: { alarm_generic: { value: false } },
  });
  harness.devices[unsupported.id] = unsupported;
  await assert.rejects(harness.bridge.enableDevice(unsupported.id), /no capabilities supported/);
  assert.equal(harness.bridge.enabledDeviceIds.has(unsupported.id), false);
  assert.equal(harness.bridge.deviceEndpoints[unsupported.id], undefined);
  assert.deepEqual(harness.errors, []);
});
