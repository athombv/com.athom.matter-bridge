import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { mappings } from './mappings/manifest.mjs';
import { eventually } from './mappings/eventually.mjs';

const light = mappings.find((fixture) => {
  return fixture.id === 'light-extended-color';
});
const options = { optionsMask: { executeIfOff: true }, optionsOverride: { executeIfOff: true } };

test('step and individual color commands reach Homey and propagate source rejections', { timeout: 60000 }, async (t) => {
  const harness = await BridgeHarness.create([light]);
  t.after(async () => {
    await harness.close();
  });
  const endpoint = harness.endpoint(light.id);
  const device = harness.devices[light.id];
  const vectors = [
    ['LevelControl', 'step', { stepMode: 0, stepSize: 25, transitionTime: 0 }, 'dim', 'currentLevel', 153, 152 / 253],
    ['LevelControl', 'stepWithOnOff', { stepMode: 1, stepSize: 25, transitionTime: 0 }, 'dim', 'currentLevel', 103, 102 / 253],
    ['ColorControl', 'moveToHue', { hue: 200, direction: 0, transitionTime: 0 }, 'light_hue', 'currentHue', 200, 200 / 254],
    ['ColorControl', 'stepHue', { stepMode: 1, stepSize: 10, transitionTime: 0 }, 'light_hue', 'currentHue', 137, 137 / 254],
    ['ColorControl', 'moveToSaturation', { saturation: 180, transitionTime: 0 }, 'light_saturation', 'currentSaturation', 180, 180 / 254],
    ['ColorControl', 'stepSaturation', { stepMode: 3, stepSize: 15, transitionTime: 0 }, 'light_saturation', 'currentSaturation', 112, 112 / 254],
    ['ColorControl', 'stepColorTemperature', { stepMode: 1, stepSize: 20, transitionTime: 0, colorTemperatureMinimumMireds: 153, colorTemperatureMaximumMireds: 400 }, 'light_temperature', 'colorTemperatureMireds', 297, 144 / 247],
  ];

  for (const [cluster, command, fields, capability, attribute, expected, sourceValue] of vectors) {
    await t.test(command, async () => {
      device.emit(capability, 0.5);
      const initial = { dim: 128, light_temperature: 277 }[capability] ?? 127;
      await harness.expectReport(endpoint, cluster, attribute, initial);
      device.writes.length = 0;
      await harness.invoke(endpoint, cluster, command, { ...options, ...fields });
      await harness.expectReport(endpoint, cluster, attribute, expected);
      assert.ok(device.writes.some((write) => {
        return write.capabilityId === capability && Math.abs(write.value - sourceValue) < 1e-9;
      }), `${command}: expected source write`);

      device.emit(capability, 0.5);
      await harness.expectReport(endpoint, cluster, attribute, initial);
      device.rejectWrites = true;
      await assert.rejects(harness.invoke(endpoint, cluster, command, { ...options, ...fields }));
      device.rejectWrites = false;
      assert.equal(await harness.read(endpoint, cluster, attribute), initial);
    });
  }
});

test('continuous brightness and color movement stops issuing Homey writes after Stop', { timeout: 60000 }, async (t) => {
  const harness = await BridgeHarness.create([light]);
  t.after(async () => {
    await harness.close();
  });
  const endpoint = harness.endpoint(light.id);
  const device = harness.devices[light.id];
  const vectors = [
    ['LevelControl', 'move', 'stop', { moveMode: 0, rate: 40 }, 'dim'],
    ['LevelControl', 'moveWithOnOff', 'stopWithOnOff', { moveMode: 1, rate: 40 }, 'dim'],
    ['ColorControl', 'moveHue', 'stopMoveStep', { moveMode: 1, rate: 40 }, 'light_hue'],
    ['ColorControl', 'moveSaturation', 'stopMoveStep', { moveMode: 3, rate: 40 }, 'light_saturation'],
    ['ColorControl', 'moveColorTemperature', 'stopMoveStep', { moveMode: 1, rate: 30, colorTemperatureMinimumMireds: 153, colorTemperatureMaximumMireds: 400 }, 'light_temperature'],
  ];

  for (const [cluster, command, stop, fields, capability] of vectors) {
    await t.test(command, async () => {
      const attribute = {
        dim: 'currentLevel', light_hue: 'currentHue', light_saturation: 'currentSaturation',
        light_temperature: 'colorTemperatureMireds',
      }[capability];
      const initial = { dim: 128, light_temperature: 277 }[capability] ?? 127;
      device.emit(capability, 0.5);
      await harness.expectReport(endpoint, cluster, attribute, initial);
      device.writes.length = 0;
      await harness.invoke(endpoint, cluster, command, { ...options, ...fields });
      await eventually(() => {
        assert.ok(device.writes.filter((write) => {
          return write.capabilityId === capability;
        }).length >= 2);
      });
      await harness.invoke(endpoint, cluster, stop, options);
      const count = device.writes.length;
      await setTimeout(300);
      assert.equal(device.writes.length, count, 'Stopped movement must not keep writing');

      // Reset away from a limit: under a busy runner the preceding move may have reached it.
      device.emit(capability, 0.5);
      await harness.expectReport(endpoint, cluster, attribute, initial);
      device.rejectWrites = true;
      try {
        await assert.rejects(harness.invoke(endpoint, cluster, command, { ...options, ...fields }));
        await assert.rejects(harness.invoke(endpoint, cluster, command, { ...options, ...fields, rate: 1 }));
      } finally {
        device.rejectWrites = false;
      }
      const rejectedCount = device.writes.length;
      await setTimeout(300);
      assert.equal(device.writes.length, rejectedCount, 'Rejected movement must not leave a timer running');

      if (cluster === 'ColorControl') {
        await harness.invoke(endpoint, cluster, command, { ...options, ...fields });
        await harness.invoke(endpoint, cluster, command, { ...options, ...fields, moveMode: 0 });
        const stoppedCount = device.writes.length;
        await setTimeout(300);
        assert.equal(device.writes.length, stoppedCount, 'MoveMode Stop must cancel the actual movement');
      }

      await harness.invoke(endpoint, cluster, command, { ...options, ...fields });
      const attempts = device.attempts;
      device.rejectWrites = true;
      await eventually(() => {
        assert.ok(device.attempts > attempts, 'The next timer step must reach Homey');
      });
      const failedAttempts = device.attempts;
      await setTimeout(300);
      device.rejectWrites = false;
      assert.equal(device.attempts, failedAttempts, 'A failed timer step must abort the transition');
      const sourceValue = device.capabilitiesObj[capability].value;
      let expected = Math.round(sourceValue * 254);

      if (capability === 'dim') {
        expected = Math.round(1 + sourceValue * 253);
      } else if (capability === 'light_temperature') {
        expected = Math.round(153 + sourceValue * 247);
      }

      assert.equal(await harness.read(endpoint, cluster, attribute), expected,
        'The reported value must match the last accepted source value');
    });
  }
});

test('brightness limits couple on/off through Homey and honor execution while off', { timeout: 15000 }, async (t) => {
  const harness = await BridgeHarness.create([light]);
  t.after(async () => {
    await harness.close();
  });
  const endpoint = harness.endpoint(light.id);
  const device = harness.devices[light.id];
  await harness.invoke(endpoint, 'LevelControl', 'stepWithOnOff', { ...options, stepMode: 1, stepSize: 254, transitionTime: 0 });
  await harness.expectReport(endpoint, 'LevelControl', 'currentLevel', 1);
  await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
  assert.ok(device.writes.some((write) => {
    return write.capabilityId === 'onoff' && write.value === false;
  }));
  device.writes.length = 0;
  await harness.invoke(endpoint, 'LevelControl', 'step', { stepMode: 0, stepSize: 25, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
  assert.deepEqual(device.writes, [], 'A step without execute-if-off must not change an off light');
  await harness.invoke(endpoint, 'LevelControl', 'stepWithOnOff', { ...options, stepMode: 0, stepSize: 254, transitionTime: 0 });
  await harness.expectReport(endpoint, 'LevelControl', 'currentLevel', 254);
  await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
  assert.ok(device.writes.some((write) => {
    return write.capabilityId === 'onoff' && write.value === true;
  }));
});

test('an unchanged hue target still switches the physical color mode and preserves rejected state', { timeout: 15000 }, async (t) => {
  const harness = await BridgeHarness.create([light]);
  t.after(async () => {
    await harness.close();
  });
  const endpoint = harness.endpoint(light.id);
  const device = harness.devices[light.id];
  device.emit('light_hue', 0.5);
  device.emit('light_mode', 'temperature');
  await harness.expectReport(endpoint, 'ColorControl', 'currentHue', 127);
  await harness.expectReport(endpoint, 'ColorControl', 'colorMode', 2);
  await harness.invoke(endpoint, 'ColorControl', 'moveToHue', { ...options, hue: 127, direction: 0, transitionTime: 0 });
  await eventually(() => {
    assert.equal(device.capabilitiesObj.light_mode.value, 'color');
  });
  await harness.expectReport(endpoint, 'ColorControl', 'colorMode', 0);

  device.emit('light_mode', 'temperature');
  await harness.expectReport(endpoint, 'ColorControl', 'colorMode', 2);
  device.rejectWrites = true;
  await assert.rejects(harness.invoke(endpoint, 'ColorControl', 'moveToHue', { ...options, hue: 127, direction: 0, transitionTime: 0 }));
  device.rejectWrites = false;
  assert.equal(await harness.read(endpoint, 'ColorControl', 'colorMode'), 2);
  assert.equal(await harness.read(endpoint, 'ColorControl', 'enhancedColorMode'), 2);
});

test('cover commands reject unavailable source operations and timed unlock is not advertised', { timeout: 30000 }, async (t) => {
  const selected = ['position-cover', 'state-cover', 'lock-true'].map((id) => {
    return mappings.find((fixture) => {
      return fixture.id === id;
    });
  });
  const harness = await BridgeHarness.create(selected);
  t.after(async () => {
    await harness.close();
  });

  await assert.rejects(harness.invoke(harness.endpoint('position-cover'), 'WindowCovering', 'stopMotion', {}));
  await assert.rejects(harness.invoke(harness.endpoint('state-cover'), 'WindowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 5000 }));
  assert.deepEqual(harness.devices['position-cover'].writes, []);
  assert.deepEqual(harness.devices['state-cover'].writes, []);
  const commands = await harness.read(harness.endpoint('lock-true'), 'DoorLock', 'acceptedCommandList');
  assert.deepEqual(commands, [0, 1]);
});

test('scene recall applies stored source state and propagates Homey failures', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create([light]);
  t.after(async () => {
    await harness.close();
  });
  const endpoint = harness.endpoint(light.id);
  const device = harness.devices[light.id];
  device.emit('light_mode', 'temperature');
  device.emit('light_temperature', 0.5);
  device.emit('dim', 0.5);
  device.emit('onoff', true);
  await harness.expectReport(endpoint, 'ColorControl', 'enhancedColorMode', 2);
  await harness.expectReport(endpoint, 'ColorControl', 'colorTemperatureMireds', 277);
  await harness.expectReport(endpoint, 'LevelControl', 'currentLevel', 128);
  await harness.invoke(endpoint, 'ScenesManagement', 'storeScene', { groupId: 0, sceneId: 1 });
  device.emit('onoff', false);
  device.emit('dim', 0.25);
  device.emit('light_mode', 'color');
  device.emit('light_temperature', 0);
  await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
  await harness.expectReport(endpoint, 'ColorControl', 'enhancedColorMode', 0);
  await harness.expectReport(endpoint, 'ColorControl', 'colorTemperatureMireds', 153);
  device.writes.length = 0;
  await harness.invoke(endpoint, 'ScenesManagement', 'recallScene', { groupId: 0, sceneId: 1, transitionTime: 0 });
  await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
  await harness.expectReport(endpoint, 'LevelControl', 'currentLevel', 128);
  await harness.expectReport(endpoint, 'ColorControl', 'enhancedColorMode', 2);
  await harness.expectReport(endpoint, 'ColorControl', 'colorTemperatureMireds', 277);
  assert.deepEqual(Object.fromEntries(device.writes.map((write) => {
    return [write.capabilityId, write.value];
  })), { onoff: true, dim: 127 / 253, light_mode: 'temperature', light_temperature: 124 / 247 });

  device.emit('dim', 0);
  await harness.expectReport(endpoint, 'LevelControl', 'currentLevel', 1);
  device.rejectWrites = true;
  await assert.rejects(harness.invoke(endpoint, 'ScenesManagement', 'recallScene', { groupId: 0, sceneId: 1, transitionTime: 0 }));
  device.rejectWrites = false;
  assert.equal(await harness.read(endpoint, 'LevelControl', 'currentLevel'), 1);

  device.emit('light_mode', 'color');
  device.emit('light_saturation', 0.5);
  await harness.expectReport(endpoint, 'ColorControl', 'enhancedColorMode', 0);
  await harness.expectReport(endpoint, 'ColorControl', 'currentSaturation', 127);
  await harness.invoke(endpoint, 'ScenesManagement', 'storeScene', { groupId: 0, sceneId: 2 });
  device.emit('light_saturation', 0);
  await harness.expectReport(endpoint, 'ColorControl', 'currentSaturation', 0);
  await harness.invoke(endpoint, 'ScenesManagement', 'recallScene', { groupId: 0, sceneId: 2, transitionTime: 0 });
  await harness.expectReport(endpoint, 'ColorControl', 'currentSaturation', 127);
  assert.ok(device.writes.some((write) => {
    return write.capabilityId === 'light_saturation' && write.value === 0.5;
  }));
});

test('Identify explicitly advertises no physical identification and maintains its countdown', { timeout: 15000 }, async (t) => {
  const harness = await BridgeHarness.create([light]);
  t.after(async () => {
    await harness.close();
  });
  const endpoint = harness.endpoint(light.id);
  const device = harness.devices[light.id];
  assert.equal(await harness.read(endpoint, 'Identify', 'identifyType'), 0);
  await harness.invoke(endpoint, 'Identify', 'identify', { identifyTime: 1 });
  await harness.expectReport(endpoint, 'Identify', 'identifyTime', 1);
  await harness.expectReport(endpoint, 'Identify', 'identifyTime', 0);
  await harness.invoke(endpoint, 'Identify', 'triggerEffect', { effectIdentifier: 0, effectVariant: 0 });
  assert.deepEqual(device.writes, [], 'No physical identification effect is advertised');
});

test('independent channel movement cleans up on disable and works after re-enabling', { timeout: 30000 }, async (t) => {
  const fixture = mappings.find((item) => {
    return item.id === 'sub-light-extended-color';
  });
  const harness = await BridgeHarness.create([fixture]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices[fixture.id];
  const endpointId = 'channel:secondary:main';
  const endpoint = harness.endpoint(fixture.id, endpointId);
  await harness.invoke(endpoint, 'LevelControl', 'move', { ...options, moveMode: 0, rate: 25 });
  assert.ok(device.writes.some((write) => {
    return write.capabilityId === 'dim.secondary';
  }));
  await harness.bridge.disableDevice(fixture.id);
  const count = device.writes.length;
  await setTimeout(300);
  assert.equal(device.writes.length, count, 'Disabled device must not receive timer writes');
  for (const listeners of device.listeners.values()) {
    assert.equal(listeners.size, 0);
  }

  await harness.bridge.enableDevice(fixture.id);
  const restored = harness.endpoint(fixture.id, endpointId);
  await harness.subscribe();
  device.emit('light_hue.secondary', 0.5);
  await harness.expectReport(restored, 'ColorControl', 'currentHue', 127);
  await harness.invoke(restored, 'ColorControl', 'stepHue', { ...options, stepMode: 1, stepSize: 10, transitionTime: 0 });
  await harness.expectReport(restored, 'ColorControl', 'currentHue', 137);
  assert.equal(device.writes.at(-1).capabilityId.includes('.secondary'), true);
  await harness.restart();
  assert.equal(harness.endpoint(fixture.id, endpointId), restored);
  assert.equal(await harness.read(restored, 'ColorControl', 'currentHue'), 137);
});

test('a cover with position and movement capabilities preserves its endpoint and can stop', { timeout: 30000 }, async (t) => {
  const fixture = mappings.find((item) => {
    return item.id === 'position-cover';
  });
  const harness = await BridgeHarness.create([fixture]);
  t.after(async () => {
    await harness.close();
  });
  const endpoint = harness.endpoint(fixture.id);
  const device = harness.devices[fixture.id];
  device.capabilitiesObj.windowcoverings_state = {
    value: 'up', type: 'enum', getable: true, setable: true,
    values: [{ id: 'up' }, { id: 'down' }, { id: 'idle' }],
  };
  await harness.restart();
  assert.equal(harness.endpoint(fixture.id), endpoint);
  await harness.expectReport(endpoint, 'WindowCovering', 'operationalStatus', { global: 1, lift: 1, tilt: 0 });
  await harness.invoke(endpoint, 'WindowCovering', 'stopMotion', {});
  assert.deepEqual(device.writes.at(-1), { capabilityId: 'windowcoverings_state', value: 'idle' });
  await harness.expectReport(endpoint, 'WindowCovering', 'operationalStatus', { global: 0, lift: 0, tilt: 0 });
  device.rejectWrites = true;
  await assert.rejects(harness.invoke(endpoint, 'WindowCovering', 'stopMotion', {}));
  device.rejectWrites = false;
});
