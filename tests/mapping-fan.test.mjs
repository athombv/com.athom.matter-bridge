import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { FanMapping } from '../lib/mappings/FanMapping.mjs';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { eventually } from './mappings/eventually.mjs';

const speed = { value: 13, type: 'number', min: 1, max: 26, step: 1, setable: true };

test('custom fan speed is excluded regardless of its name or range', () => {
  assert.equal(FanMapping.speedCapability({ 'number.level': speed, onoff: {} }), null);
  assert.equal(FanMapping.speedCapability({ 'number.test_fan_speed': speed, onoff: {} }), null);
  assert.equal(FanMapping.speedCapability({ 'lg_fan_speed': speed, onoff: {} }), null);
});

test('existing on/off fan upgrades in place and handles official speed, off and unknown readings', { timeout: 40000 }, async (t) => {
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
    device.capabilitiesObj['fan_speed'] = { value: 0.5, type: 'number', min: 0, max: 1, setable: true };
    device.capabilities.push('fan_speed');
  });
  assert.equal(harness.bridge.deviceEndpoints[device.id].number, parent);
  assert.equal(harness.endpoint(device.id), endpoint);
  assert.equal((await harness.read(endpoint, 'Descriptor', 'deviceTypeList'))[0].deviceType, 0x2b);
  assert.equal(await harness.read(endpoint, 'FanControl', 'percentSetting'), 50);

  await harness.write(endpoint, 'FanControl', 'percentSetting', 25);
  await harness.expectReport(endpoint, 'FanControl', 'percentCurrent', 25);
  assert.deepEqual(device.writes, [{ capabilityId: 'fan_speed', value: 0.25 }]);

  device.writes.length = 0;
  await harness.write(endpoint, 'FanControl', 'percentSetting', 0);
  await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
  await harness.expectReport(endpoint, 'FanControl', 'percentCurrent', 0);
  assert.deepEqual(device.writes, [{ capabilityId: 'onoff', value: false }]);
  assert.equal(device.capabilitiesObj['fan_speed'].value, 0.25, 'Off retains the remembered source speed');

  await harness.write(endpoint, 'FanControl', 'fanMode', 4);
  await harness.expectReport(endpoint, 'FanControl', 'percentCurrent', 100);
  await harness.expectReport(endpoint, 'FanControl', 'fanMode', 3);
  await assert.rejects(harness.write(endpoint, 'FanControl', 'fanMode', 5));
  await assert.rejects(harness.write(endpoint, 'FanControl', 'percentSetting', null));

  device.emit('fan_speed', null);
  await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'reachable', false);
  assert.equal(await harness.read(endpoint, 'FanControl', 'percentCurrent'), 100);
  device.emit('fan_speed', 0.01);
  await harness.expectReport(endpoint, 'FanControl', 'percentCurrent', 1);
  await eventually(async () => {
    assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'reachable'), true);
  }, 'Known fan speed restores reachability');
  // Homey API Item.__update replaces capability metadata on device updates.
  device.capabilitiesObj = structuredClone(device.capabilitiesObj);
  device.emit('fan_speed', 0.5);
  await harness.expectReport(endpoint, 'FanControl', 'percentCurrent', 50);
  assert.deepEqual(harness.errors, []);
});

test('removing custom speed preserves a paired fan on/off endpoint', { timeout: 40000 }, async (t) => {
  const storageFixture = JSON.parse(await readFile(
    new URL('./fixtures/fan-policy-upgrade.json', import.meta.url), 'utf8',
  ));
  const harness = await BridgeHarness.create([{
    id: 'legacy-fan', class: 'fan', capabilities: {
      onoff: { value: true, type: 'boolean', setable: true },
      'number.fixture_fan_speed': structuredClone(speed),
    },
  }], { storageFixture });
  t.after(async () => { await harness.close(); });
  const device = harness.devices['legacy-fan'];
  const endpoint = harness.endpoint(device.id);
  assert.equal(endpoint, storageFixture.endpoints[device.id][0].number);
  assert.deepEqual((await harness.read(endpoint, 'Descriptor', 'deviceTypeList')).map((entry) => {
    return entry.deviceType;
  }), [0x10a]);
  assert.ok(!(await harness.read(endpoint, 'Descriptor', 'serverList')).includes(514));
  assert.equal(await harness.read(endpoint, 'OnOff', 'onOff'), true);
  assert.equal(device.listeners.has('number.fixture_fan_speed'), false);
  await harness.invoke(endpoint, 'OnOff', 'off', {});
  await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
  assert.deepEqual(device.writes, [{ capabilityId: 'onoff', value: false }]);
  await harness.restart();
  assert.equal(harness.endpoint(device.id), endpoint);
  device.emit('onoff', true);
  await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
  assert.deepEqual(harness.errors, []);
});
