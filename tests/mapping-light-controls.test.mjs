import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { mappings } from './mappings/manifest.mjs';

const fixture = mappings.find((mapping) => {
  return mapping.id === 'light-extended-color';
});

test('normalized light temperatures use a realistic, reversible fallback range', { timeout: 45000 }, async (t) => {
  const harness = await BridgeHarness.create([fixture]);
  t.after(async () => {
    await harness.close();
  });
  const endpoint = harness.endpoint(fixture.id);
  const device = harness.devices[fixture.id];
  assert.equal(await harness.read(endpoint, 'ColorControl', 'colorTempPhysicalMinMireds'), 153);
  assert.equal(await harness.read(endpoint, 'ColorControl', 'colorTempPhysicalMaxMireds'), 400);

  for (const [normalized, mireds] of [[0, 153], [0.25, 215], [0.5, 277], [1, 400]]) {
    device.emit('light_temperature', normalized);
    await harness.expectReport(endpoint, 'ColorControl', 'colorTemperatureMireds', mireds);
  }

  await harness.invoke(endpoint, 'ColorControl', 'moveToColorTemperature', {
    colorTemperatureMireds: 277, transitionTime: 0, optionsMask: {}, optionsOverride: {},
  });
  assert.equal(device.writes.find((write) => {
    return write.capabilityId === 'light_temperature';
  }).value, 124 / 247);
  await harness.restart();
  assert.equal(harness.endpoint(fixture.id), endpoint);
  assert.equal(await harness.read(endpoint, 'ColorControl', 'colorTempPhysicalMinMireds'), 153);
  assert.equal(await harness.read(endpoint, 'ColorControl', 'colorTemperatureMireds'), 277);
});

test('light commands forward transition durations to the source in milliseconds', { timeout: 45000 }, async (t) => {
  const harness = await BridgeHarness.create([fixture]);
  t.after(async () => {
    await harness.close();
  });
  const endpoint = harness.endpoint(fixture.id);
  const device = harness.devices[fixture.id];
  const commands = [
    ['LevelControl', 'moveToLevel', { level: 100, transitionTime: 15, optionsMask: {}, optionsOverride: {} }, ['dim'], 1500],
    ['LevelControl', 'moveToLevelWithOnOff', { level: 150, transitionTime: 20, optionsMask: {}, optionsOverride: {} }, ['onoff', 'dim'], 2000],
    ['LevelControl', 'moveToLevelWithOnOff', { level: 0, transitionTime: 20, optionsMask: {}, optionsOverride: {} }, ['onoff', 'dim'], 2000],
    ['ColorControl', 'moveToHueAndSaturation', { hue: 20, saturation: 40, transitionTime: 30, optionsMask: {}, optionsOverride: {} }, ['onoff', 'light_hue', 'light_saturation'], 3000],
    ['ColorControl', 'moveToColorTemperature', { colorTemperatureMireds: 215, transitionTime: 5, optionsMask: {}, optionsOverride: {} }, ['onoff', 'light_temperature'], 500],
    ['LevelControl', 'moveToLevel', { level: 50, transitionTime: 0, optionsMask: {}, optionsOverride: {} }, ['dim'], 0],
    ['LevelControl', 'moveToLevel', { level: 70, transitionTime: null, optionsMask: {}, optionsOverride: {} }, ['dim'], 0],
  ];

  for (const [cluster, name, fields, capabilities, duration] of commands) {
    device.writes.length = 0;
    await harness.invoke(endpoint, cluster, name, fields);

    for (const capabilityId of capabilities) {
      const write = device.writes.find((item) => {
        return item.capabilityId === capabilityId;
      });
      assert.deepEqual(write?.opts, { duration }, `${name}/${capabilityId}`);
    }
    for (const write of device.writes) {
      if (!capabilities.includes(write.capabilityId)) {
        assert.equal(write.opts, undefined, 'Mode writes do not receive a fade duration');
      }
    }
  }

  device.rejectWrites = true;
  await assert.rejects(harness.invoke(endpoint, 'LevelControl', 'moveToLevel', {
    level: 90, transitionTime: 10, optionsMask: {}, optionsOverride: {},
  }));
  assert.deepEqual(harness.errors, []);
});
