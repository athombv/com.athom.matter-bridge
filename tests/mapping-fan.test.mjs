import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FanMapping } from '../lib/mappings/FanMapping.mjs';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { eventually } from './mappings/eventually.mjs';

const speed = { value: 13, type: 'number', min: 1, max: 26, step: 1, setable: true };

test('custom fan speed requires one explicit, writable range and on/off', () => {
  assert.equal(FanMapping.speedCapability({ 'number.level': speed, onoff: {} }), null);
  assert.equal(FanMapping.speedCapability({ 'number.test_fan_speed': speed }), null);
  assert.equal(FanMapping.speedCapability({
    'number.first_fan_speed': speed, 'number.second_fan_speed': speed, onoff: {},
  }), null);
  assert.equal(FanMapping.speedCapability({
    'number.test_fan_speed': { ...speed, max: undefined }, onoff: {},
  }), null);
  assert.deepEqual(FanMapping.speedCapability({ 'number.test_fan_speed': speed, onoff: {} }), {
    id: 'number.test_fan_speed', min: 1, max: 26, step: 1,
  });
});

test('existing on/off fan upgrades in place and handles steps, off and unknown speed', { timeout: 40000 }, async (t) => {
  const harness = await BridgeHarness.create([{
    id: 'existing-fan', class: 'fan', capabilities: { onoff: { value: true, setable: true } },
  }]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices['existing-fan'];
  const parent = harness.bridge.deviceEndpoints[device.id].number;
  const endpoint = harness.endpoint(device.id);
  assert.equal((await harness.read(endpoint, 'Descriptor', 'deviceTypeList'))[0].deviceType, 0x10a);
  await harness.restart(() => {
    device.capabilitiesObj['number.test_fan_speed'] = structuredClone(speed);
    device.capabilities.push('number.test_fan_speed');
  });
  assert.equal(harness.bridge.deviceEndpoints[device.id].number, parent);
  assert.equal(harness.endpoint(device.id), endpoint);
  assert.equal((await harness.read(endpoint, 'Descriptor', 'deviceTypeList'))[0].deviceType, 0x2b);
  assert.equal(await harness.read(endpoint, 'FanControl', 'percentSetting'), 50);

  await harness.write(endpoint, 'FanControl', 'percentSetting', 25);
  await harness.expectReport(endpoint, 'FanControl', 'percentCurrent', 27);
  assert.deepEqual(device.writes, [{ capabilityId: 'number.test_fan_speed', value: 7 }]);

  device.writes.length = 0;
  await harness.write(endpoint, 'FanControl', 'percentSetting', 0);
  await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
  await harness.expectReport(endpoint, 'FanControl', 'percentCurrent', 0);
  assert.deepEqual(device.writes, [{ capabilityId: 'onoff', value: false }]);
  assert.equal(device.capabilitiesObj['number.test_fan_speed'].value, 7, 'Off retains the remembered source speed');

  await harness.write(endpoint, 'FanControl', 'fanMode', 4);
  await harness.expectReport(endpoint, 'FanControl', 'percentCurrent', 100);
  await harness.expectReport(endpoint, 'FanControl', 'fanMode', 3);
  await assert.rejects(harness.write(endpoint, 'FanControl', 'fanMode', 5));
  await assert.rejects(harness.write(endpoint, 'FanControl', 'percentSetting', null));

  device.emit('number.test_fan_speed', null);
  await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'reachable', false);
  assert.equal(await harness.read(endpoint, 'FanControl', 'percentCurrent'), 100);
  device.emit('number.test_fan_speed', 1);
  await harness.expectReport(endpoint, 'FanControl', 'percentCurrent', 4);
  await eventually(async () => {
    assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'reachable'), true);
  }, 'Known fan speed restores reachability');
  assert.deepEqual(harness.errors, []);
});
