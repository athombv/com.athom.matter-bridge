import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { eventually } from './mappings/eventually.mjs';

const fixture = {
  id: 'named-socket',
  class: 'socket',
  capabilities: { onoff: { value: true, setable: true } },
};

test('Homey renames reach the controller without replacing the device', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create([fixture]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices[fixture.id];
  const parent = harness.bridge.deviceEndpoints[device.id].number;
  const child = harness.endpoint(device.id);
  const serial = await harness.read(parent, 'BridgedDeviceBasicInformation', 'serialNumber');
  const uniqueId = await harness.read(parent, 'BridgedDeviceBasicInformation', 'uniqueId');

  assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'nodeLabel'), device.name);

  const names = [
    ['Reading lamp', 'Reading lamp'],
    ['Café lamp ↗', 'Café lamp ↗'],
    ['A'.repeat(40), `${'A'.repeat(29)}…`],
    ['é'.repeat(16), 'é'.repeat(16)],
    ['é'.repeat(17), `${'é'.repeat(14)}…`],
    ['日'.repeat(10), '日'.repeat(10)],
    ['日'.repeat(11), `${'日'.repeat(9)}…`],
    ['💡'.repeat(8), '💡'.repeat(8)],
    ['💡'.repeat(9), `${'💡'.repeat(7)}…`],
    [`${'a'.repeat(28)}💡b`, `${'a'.repeat(28)}…`],
    ['e\u0301'.repeat(12), `${'e\u0301'.repeat(9)}e…`],
    ['Desk', 'Desk'],
  ];

  for (const [name, expected] of names) {
    device.name = name;
    harness.manager.emit('device.update', device);
    await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'nodeLabel', expected);
    assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'nodeLabel'), expected);
    assert.ok(Buffer.byteLength(expected, 'utf8') <= 32);
    assert.ok(expected.isWellFormed());
  }

  assert.equal(harness.bridge.deviceEndpoints[device.id].number, parent);
  assert.equal(harness.endpoint(device.id), child);
  assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'serialNumber'), serial);
  assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'uniqueId'), uniqueId);
  assert.deepEqual(await harness.read(parent, 'Descriptor', 'partsList'), [child]);
  assert.equal(device.listeners.get('onoff').size, 1);
  assert.equal(device.attempts, 0, 'Renames must not write source capabilities');

  await harness.invoke(child, 'OnOff', 'off');
  await harness.expectReport(child, 'OnOff', 'onOff', false);
  assert.deepEqual(device.writes, [{ capabilityId: 'onoff', value: false }]);
  assert.deepEqual(harness.errors, []);
});

test('multibyte bridge and device metadata fit UTF-8 limits at startup and restart', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create([{
    ...fixture,
    name: '💡'.repeat(20),
    driver: { name: '日'.repeat(20), ownerName: 'é'.repeat(40) },
  }], {
    bridgeOptions: {
      productName: '日'.repeat(20),
      vendorName: 'é'.repeat(40),
      serialNumber: '💡'.repeat(20),
    },
  });
  t.after(async () => {
    await harness.close();
  });
  const parent = harness.bridge.deviceEndpoints[fixture.id].number;
  const child = harness.endpoint(fixture.id);

  for (const restart of [false, true]) {
    if (restart) {
      await harness.restart();
    }

    for (const [endpoint, cluster, attribute, expected] of [
      [0, 'BasicInformation', 'productName', `${'日'.repeat(9)}…`],
      [0, 'BasicInformation', 'productLabel', `${'日'.repeat(9)}…`],
      [0, 'BasicInformation', 'nodeLabel', `${'日'.repeat(9)}…`],
      [0, 'BasicInformation', 'vendorName', `${'é'.repeat(14)}…`],
      [0, 'BasicInformation', 'serialNumber', `${'💡'.repeat(7)}…`],
      [parent, 'BridgedDeviceBasicInformation', 'nodeLabel', `${'💡'.repeat(7)}…`],
      [parent, 'BridgedDeviceBasicInformation', 'productName', `${'日'.repeat(9)}…`],
      [parent, 'BridgedDeviceBasicInformation', 'vendorName', `${'é'.repeat(14)}…`],
    ]) {
      const actual = await harness.read(endpoint, cluster, attribute);

      assert.equal(actual, expected, `${cluster}.${attribute}`);
      assert.ok(Buffer.byteLength(actual, 'utf8') <= 32);
      assert.ok(actual.isWellFormed());
    }

    assert.equal(harness.endpoint(fixture.id), child);
    assert.equal(harness.bridge.deviceEndpoints[fixture.id].number, parent);
    assert.equal(harness.bridge.serverNode.lifecycle.isCommissioned, true);
    assert.equal(harness.devices[fixture.id].attempts, 0);
    assert.deepEqual(harness.errors, []);
  }
});

test('restart refreshes a persisted Matter name from Homey', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create([fixture]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices[fixture.id];
  const endpoint = harness.bridge.deviceEndpoints[device.id];
  const parent = endpoint.number;
  const child = harness.endpoint(device.id);

  await endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: 'Previously saved name' } });
  await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'nodeLabel', 'Previously saved name');

  await harness.restart(() => {
    device.name = 'Renamed while stopped';
  });

  assert.equal(harness.bridge.deviceEndpoints[device.id].number, parent);
  assert.equal(harness.endpoint(device.id), child);
  assert.equal(harness.bridge.serverNode.lifecycle.isCommissioned, true);
  assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'nodeLabel'), device.name);
  await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'nodeLabel', device.name);

  device.name = 'Renamed after restart';
  harness.manager.emit('device.update', device);
  await eventually(async () => {
    assert.deepEqual(harness.errors, []);
    assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'nodeLabel'), device.name);
  }, 'Controller reads renamed device after restart');
  await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'nodeLabel', device.name);
  assert.deepEqual(harness.errors, []);
});

test('names follow Homey through delayed readiness and disable/re-enable', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create([
    { ...fixture, ready: false },
    { ...fixture, id: 'unchanged-socket' },
  ]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices[fixture.id];
  const parent = harness.bridge.deviceEndpoints[device.id].number;

  device.name = 'Waiting for driver';
  harness.manager.emit('device.update', device);
  await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'nodeLabel', device.name);
  assert.equal(harness.bridge.deviceEndpointInstances[device.id], undefined);

  device.ready = true;
  harness.manager.emit('device.update', device);
  await eventually(() => {
    assert.ok(harness.endpoint(device.id));
  }, 'Renamed device becomes ready');

  harness.bridge.pauseQueue();
  device.name = 'Rename queued before disable';
  harness.manager.emit('device.update', device);
  const disablePromise = harness.bridge.disableDevice(device.id);
  await eventually(() => {
    assert.equal(harness.bridge.enabledDeviceIds.has(device.id), false);
  }, 'Device is disabled before queued work resumes');
  harness.bridge.resumeQueue();
  await disablePromise;

  device.name = 'Renamed while disabled';
  harness.manager.emit('device.update', device);
  assert.equal(harness.bridge.deviceEndpoints[device.id], undefined);
  assert.equal(device.listeners.get('onoff').size, 0);

  await harness.bridge.enableDevice(device.id);
  const restoredParent = harness.bridge.deviceEndpoints[device.id].number;

  assert.equal(await harness.read(restoredParent, 'BridgedDeviceBasicInformation', 'nodeLabel'), device.name);
  device.name = 'Renamed after re-enable';
  harness.manager.emit('device.update', device);
  await harness.expectReport(restoredParent, 'BridgedDeviceBasicInformation', 'nodeLabel', device.name);
  device.emit('onoff', false);
  await harness.expectReport(harness.endpoint(device.id), 'OnOff', 'onOff', false);
  assert.equal(device.listeners.get('onoff').size, 1);
  assert.deepEqual(harness.errors, []);
});
