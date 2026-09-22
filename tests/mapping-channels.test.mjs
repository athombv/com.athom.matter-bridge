import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MatterBridgeServer } from '../lib/MatterBridgeServer.mjs';
import { SimulatedDevice } from './mappings/SimulatedDevice.mjs';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';

const writable = (value) => {
  return { value, getable: true, setable: true, type: typeof value };
};

test('only implemented official capability bases with compatible measurement metadata are shared', () => {
  const device = new SimulatedDevice({
    id: 'policy', class: 'fan', capabilities: {
      onoff: writable(true),
      'number.fixture_fan_speed': { ...writable(13), min: 1, max: 26, step: 1 },
      'boolean.oscillating': writable(false),
      lg_fan_speed: writable(0.5),
      'measure_current.valid': { value: 1.25, units: 'A', type: 'number', getable: true },
      'measure_current.wrong_units': { value: 1250, units: 'mA' },
      'measure_voltage.write_only': { value: 230, units: 'V', getable: false },
      'measure_voltage.wrong_type': { value: '230', units: 'V', type: 'string' },
      'measure_pm1.valid': { value: 12, units: 'μg/m³' },
      'measure_pm1.index': { value: 12, units: 'ticks' },
      'meter_power.daily': { value: 12, units: 'kWh' },
      'onoff.': writable(true),
    },
  });
  const support = MatterBridgeServer.getDeviceSupport(device);
  assert.deepEqual(support.supportedCapabilities, ['onoff', 'measure_current.valid', 'measure_pm1.valid']);
  assert.equal(support.unsupportedCapabilities.length, 9);
});

test('independent light channels route full capability IDs and retain identity after restart', { timeout: 60000 }, async (t) => {
  const fixture = {
    id: 'channels', class: 'light', capabilities: {
      onoff: writable(true), dim: writable(1),
      'onoff.left': writable(false), 'dim.left': writable(0.5),
      'onoff.right': writable(true), 'dim.right': writable(0.25),
      'measure_temperature.probe': { value: 21.25, type: 'number', getable: true },
    },
  };
  const harness = await BridgeHarness.create([{
    ...fixture, capabilities: { onoff: writable(true), dim: writable(1) },
  }]);
  t.after(async () => { await harness.close(); });
  const device = harness.devices.channels;
  const originalMain = harness.endpoint(device.id);
  await harness.restart(() => {
    Object.assign(device.capabilitiesObj, fixture.capabilities);
    device.capabilities = Object.keys(device.capabilitiesObj);
  });
  assert.equal(harness.endpoint(device.id), originalMain, 'Adding channels preserves the paired light');
  const main = harness.endpoint(device.id);
  const left = harness.endpoint(device.id, 'channel:left:main');
  const right = harness.endpoint(device.id, 'channel:right:main');
  const probe = harness.endpoint(device.id, 'channel:probe:measure_temperature');
  assert.equal(new Set([main, left, right, probe]).size, 4);
  assert.equal(await harness.read(main, 'LevelControl', 'currentLevel'), 254);
  assert.equal(await harness.read(left, 'LevelControl', 'currentLevel'), 128);
  assert.equal(await harness.read(right, 'LevelControl', 'currentLevel'), 64);
  assert.deepEqual((await harness.read(probe, 'Descriptor', 'deviceTypeList')).map((entry) => {
    return entry.deviceType;
  }), [0x302], 'A temperature sub-capability must not advertise light controls');

  await harness.invoke(left, 'LevelControl', 'moveToLevelWithOnOff', { level: 254, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
  await harness.expectReport(left, 'LevelControl', 'currentLevel', 254);
  assert.deepEqual(device.writes.map(({ capabilityId, value }) => {
    return { capabilityId, value };
  }), [{ capabilityId: 'onoff.left', value: true }, { capabilityId: 'dim.left', value: 1 }]);
  assert.equal(await harness.read(right, 'LevelControl', 'currentLevel'), 64);
  assert.equal(await harness.read(main, 'LevelControl', 'currentLevel'), 254);

  const parent = harness.bridge.deviceEndpoints[device.id].number;
  device.emit('onoff.right', null);
  await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'reachable', false);
  device.emit('onoff.right', true);
  await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'reachable', true);
  device.capabilitiesObj['onoff.right'].setable = false;
  device.writes.length = 0;
  await assert.rejects(harness.invoke(right, 'OnOff', 'off', {}));
  assert.deepEqual(device.writes, []);

  await harness.restart(() => {
    for (const listeners of device.listeners.values()) {
      assert.equal(listeners.size, 0);
    }
    device.emit('dim.left', 0.25);
  });
  assert.equal(harness.endpoint(device.id), main);
  assert.equal(harness.endpoint(device.id, 'channel:left:main'), left);
  assert.equal(harness.endpoint(device.id, 'channel:right:main'), right);
  assert.equal(harness.endpoint(device.id, 'channel:probe:measure_temperature'), probe);
  await harness.expectReport(left, 'LevelControl', 'currentLevel', 64);
  device.emit('measure_temperature.probe', 0);
  await harness.expectReport(probe, 'TemperatureMeasurement', 'measuredValue', 0);
  for (const listeners of device.listeners.values()) {
    assert.equal(listeners.size, 1);
  }
  await harness.bridge.disableDevice(device.id);
  for (const listeners of device.listeners.values()) {
    assert.equal(listeners.size, 0);
  }
  await harness.bridge.enableDevice(device.id);
  device.emit('dim.left', 1);
  await harness.expectReport(harness.endpoint(device.id, 'channel:left:main'), 'LevelControl', 'currentLevel', 254);
  assert.deepEqual(harness.errors, []);
});
