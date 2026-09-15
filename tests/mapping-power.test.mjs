import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';

test('energy and battery additions preserve existing socket endpoints and pairing', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create([{
    id: 'existing-socket', class: 'socket', capabilities: {
      onoff: { value: true, setable: true }, measure_power: { value: 12.5 },
    },
  }]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices['existing-socket'];
  const parent = harness.bridge.deviceEndpoints[device.id].number;
  const main = harness.endpoint(device.id);
  await harness.restart(() => {
    Object.assign(device.capabilitiesObj, {
      meter_power: { value: 1.25 },
      measure_battery: { value: 75 },
      alarm_battery: { value: false },
    });
    device.capabilities = Object.keys(device.capabilitiesObj);
  });
  assert.equal(harness.bridge.deviceEndpoints[device.id].number, parent);
  assert.equal(harness.endpoint(device.id), main);
  assert.equal(harness.bridge.serverNode.lifecycle.isCommissioned, true);
  assert.equal(await harness.read(main, 'ElectricalPowerMeasurement', 'activePower'), 12500);
  const energy = harness.endpoint(device.id, 'energy');
  const battery = harness.endpoint(device.id, 'battery');
  assert.deepEqual(await harness.read(energy, 'ElectricalEnergyMeasurement', 'cumulativeEnergyImported'), { energy: 1250000 });
  assert.equal(await harness.read(battery, 'PowerSource', 'batPercentRemaining'), 150);

  device.emit('alarm_battery', true);
  await harness.expectReport(battery, 'PowerSource', 'batChargeLevel', 1);
  await harness.expectReport(battery, 'PowerSource', 'batReplacementNeeded', true);
  assert.equal(await harness.read(battery, 'PowerSource', 'batPercentRemaining'), 150,
    'A low-battery alarm must not invent a percentage');

  for (const [value, expected] of [[0.000001, { energy: 1 }], [9000000000, { energy: 9000000000000000n }], [10000000000, null]]) {
    device.emit('meter_power', value);
    await harness.expectReport(energy, 'ElectricalEnergyMeasurement', 'cumulativeEnergyImported', expected);
  }

  device.emit('onoff', false);
  await harness.expectReport(main, 'OnOff', 'onOff', false);
  assert.deepEqual(harness.errors, []);
});

test('battery percentage clamps limits without turning unknown into zero', { timeout: 50000 }, async (t) => {
  const harness = await BridgeHarness.create([{
    id: 'battery-bounds', class: 'sensor', capabilities: { measure_battery: { value: null } },
  }]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices['battery-bounds'];
  const endpoint = harness.endpoint(device.id, 'battery');
  assert.equal(await harness.read(endpoint, 'PowerSource', 'batPercentRemaining'), null);

  for (const [value, expected] of [[-1, 0], [101, 200], [null, null]]) {
    device.emit('measure_battery', value);
    await harness.expectReport(endpoint, 'PowerSource', 'batPercentRemaining', expected);
  }
  assert.deepEqual(harness.errors, []);
});
