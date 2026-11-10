import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { MatterBridgeServer } from '../lib/MatterBridgeServer.mjs';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { mappings } from './mappings/manifest.mjs';

test('dim-only light channels switch their own source and retain paired endpoints', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create([{
    id: 'dim-channel', class: 'light', capabilities: {
      onoff: { value: true, setable: true },
      'dim.secondary': { value: 0.6, setable: true },
    },
  }]);
  t.after(async () => { await harness.close(); });
  const device = harness.devices['dim-channel'];
  const main = harness.endpoint(device.id);
  const secondary = harness.endpoint(device.id, 'channel:secondary:main');
  assert.equal(await harness.read(secondary, 'OnOff', 'onOff'), true);

  await harness.invoke(secondary, 'OnOff', 'off', {});
  await harness.expectReport(secondary, 'OnOff', 'onOff', false);
  await harness.invoke(secondary, 'OnOff', 'on', {});
  await harness.expectReport(secondary, 'OnOff', 'onOff', true);
  assert.deepEqual(device.writes, [
    { capabilityId: 'dim.secondary', value: 0 },
    { capabilityId: 'dim.secondary', value: 0.6 },
  ]);
  assert.equal(await harness.read(main, 'OnOff', 'onOff'), true);

  device.rejectWrites = true;
  await assert.rejects(harness.invoke(secondary, 'OnOff', 'off', {}));
  device.rejectWrites = false;
  assert.equal(await harness.read(secondary, 'OnOff', 'onOff'), true);
  device.emit('dim.secondary', 0);
  await harness.expectReport(secondary, 'OnOff', 'onOff', false);
  device.emit('dim.secondary', 0.25);
  await harness.expectReport(secondary, 'OnOff', 'onOff', true);
  await harness.restart();
  assert.equal(harness.endpoint(device.id), main);
  assert.equal(harness.endpoint(device.id, 'channel:secondary:main'), secondary);
  await harness.invoke(secondary, 'OnOff', 'toggle', {});
  await harness.expectReport(secondary, 'OnOff', 'onOff', false);
  assert.deepEqual(harness.errors, []);
});

test('read-only fan speed still permits writable Off controls', { timeout: 15000 }, async (t) => {
  const harness = await BridgeHarness.create([{
    id: 'readonly-fan', class: 'fan', capabilities: {
      onoff: { value: true, setable: true }, fan_speed: { value: 0.5, setable: false },
    },
  }]);
  t.after(async () => { await harness.close(); });
  const device = harness.devices['readonly-fan'];
  const endpoint = harness.endpoint(device.id);
  for (const attribute of ['fanMode', 'percentSetting']) {
    await harness.write(endpoint, 'FanControl', attribute, 0);
    await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
    assert.equal(device.capabilitiesObj.fan_speed.value, 0.5);
    device.emit('onoff', true);
    await harness.expectReport(endpoint, 'FanControl', 'percentCurrent', 50);
  }
  assert.deepEqual(device.writes, [
    { capabilityId: 'onoff', value: false }, { capabilityId: 'onoff', value: false },
  ]);
  await assert.rejects(harness.write(endpoint, 'FanControl', 'percentSetting', 75));
  device.capabilitiesObj.onoff.setable = false;
  await assert.rejects(harness.write(endpoint, 'FanControl', 'fanMode', 0));
  assert.equal(await harness.read(endpoint, 'OnOff', 'onOff'), true);
});

test('auto thermostat forwards both targets when a command crosses the deadband', { timeout: 15000 }, async (t) => {
  const fixture = {
    id: 'auto-deadband', class: 'thermostat', capabilities: {
      target_temperature: { value: 20, min: 16, max: 30, setable: true },
      'target_temperature.cool': { value: 22, min: 16, max: 30, setable: true },
      thermostat_mode: { value: 'auto', setable: true, values: [{ id: 'heat' }, { id: 'cool' }, { id: 'auto' }] },
    },
  };
  const harness = await BridgeHarness.create([fixture]);
  t.after(async () => { await harness.close(); });
  const device = harness.devices[fixture.id];
  const endpoint = harness.endpoint(device.id);
  // This bridge declares a zero deadband; even that requires moving the opposite target
  // when heating crosses above cooling or cooling crosses below heating.
  for (const [mode, amount, heat, cool] of [[0, 30, 23, 23], [1, -30, 20, 20]]) {
    device.writes.length = 0;
    await harness.invoke(endpoint, 'Thermostat', 'setpointRaiseLower', { mode, amount });
    await harness.expectReport(endpoint, 'Thermostat', 'occupiedHeatingSetpoint', heat * 100);
    await harness.expectReport(endpoint, 'Thermostat', 'occupiedCoolingSetpoint', cool * 100);
    assert.deepEqual(Object.fromEntries(device.writes.map((write) => {
      return [write.capabilityId, write.value];
    })), { target_temperature: heat, 'target_temperature.cool': cool });
    assert.equal(device.capabilitiesObj.target_temperature.value, heat);
    assert.equal(device.capabilitiesObj['target_temperature.cool'].value, cool);
  }
  assert.deepEqual(harness.errors, []);
});

test('shutdown attempts every subscription and closes Matter despite cleanup failures', async () => {
  const server = new MatterBridgeServer({ api: { devices: new EventEmitter() }, debug: () => {} });
  const calls = [];
  const failures = [new Error('first subscription'), new Error('second subscription')];
  server.deviceCapabilityInstances = { a: {
    first: { async destroy() { calls.push('first'); throw failures[0]; } },
    second: { async destroy() { calls.push('second'); throw failures[1]; } },
    third: { async destroy() { calls.push('third'); } },
  } };
  server.serverNode = { async close() { calls.push('server'); } };
  await assert.rejects(server.stop(), (error) => {
    assert.deepEqual(error.errors, failures);
    return true;
  });
  assert.deepEqual(calls, ['first', 'second', 'third', 'server']);
  assert.deepEqual(server.deviceCapabilityInstances, {});
  assert.equal(server.serverNode, null);
});

test('disable cleans remaining resources after a rejected destroy and allows re-enabling', { timeout: 15000 }, async (t) => {
  const fixture = mappings.find((item) => { return item.id === 'socket'; });
  const harness = await BridgeHarness.create([fixture]);
  t.after(async () => { await harness.close(); });
  const device = harness.devices.socket;
  const instance = harness.bridge.deviceCapabilityInstances.socket.onoff;
  const destroy = instance.destroy.bind(instance);
  instance.destroy = async () => {
    await destroy();
    throw new Error('Cleanup reported a failure');
  };
  await harness.bridge.disableDevice(device.id);
  assert.equal(harness.bridge.deviceEndpoints.socket, undefined);
  assert.equal(harness.bridge.deviceEndpointInstances.socket, undefined);
  assert.equal(harness.bridge.deviceCapabilityInstances.socket, undefined);
  for (const listeners of device.listeners.values()) {
    assert.equal(listeners.size, 0);
  }
  await harness.bridge.enableDevice(device.id);
  await harness.invoke(harness.endpoint(device.id), 'OnOff', 'off', {});
  await harness.expectReport(harness.endpoint(device.id), 'OnOff', 'onOff', false);
  for (const listeners of device.listeners.values()) {
    assert.equal(listeners.size, 1);
  }
});
