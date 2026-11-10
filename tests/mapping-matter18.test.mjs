import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { DeviceTypeConformanceService } from '@matter/main';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { mappings } from './mappings/manifest.mjs';
import { eventually } from './mappings/eventually.mjs';

const light = mappings.find((fixture) => {
  return fixture.id === 'light-extended-color';
});
const options = { optionsMask: { executeIfOff: true }, optionsOverride: { executeIfOff: true } };

test('Matter 1.6.1 validates every mapping without hiding conformance warnings', { timeout: 60000 }, async (t) => {
  const harness = await BridgeHarness.create(mappings);
  t.after(async () => {
    await harness.close();
  });
  const node = harness.bridge.serverNode;
  const verdict = node.env.get(DeviceTypeConformanceService).validateNodeScope(node, { refuse: false });
  const unexpected = [];
  const unavailablePowerMetadata = [];

  for (const [endpoint, violations] of verdict) {
    for (const violation of violations) {
      // The bridge cannot infer a physical power supply from alarm_smoke. Preserve existing
      // alarms rather than invent battery/mains data. This is the sole known mapping exception.
      if (violation.deviceType === 'SmokeCoAlarm' && violation.requirement === 'device:PowerSource' &&
          violation.kind === 'instanceCount') {
        unavailablePowerMetadata.push(endpoint.toString());
        continue;
      }
      if (!violation.assertedAtRoot) {
        unexpected.push({ endpoint: endpoint.toString(), ...violation });
      }
    }
  }

  assert.deepEqual(unexpected, []);
  assert.deepEqual(unavailablePowerMetadata.sort(), [
    'mapping-bridge.aggregator.alarm_smoke.alarm_smoke',
    'mapping-bridge.aggregator.sub-alarm_smoke.channel:secondary:alarm_smoke',
  ]);
});

test('XY color commands preserve existing light identity and control the source', { timeout: 45000 }, async (t) => {
  const harness = await BridgeHarness.create([light]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices[light.id];
  const endpoint = harness.endpoint(light.id);
  const types = await harness.read(endpoint, 'Descriptor', 'deviceTypeList');
  assert.equal(types[0].deviceType, 0x10d, 'Keep the existing Extended Color Light type');

  // Fixed wide-RGB red vector (0.7006, 0.2993), independent of the bridge conversion.
  // Homey exposes no physical gamut; this exercises the SDK fallback, not lamp calibration.
  await harness.invoke(endpoint, 'ColorControl', 'moveToColor', {
    ...options, colorX: 45915, colorY: 19615, transitionTime: 5,
  });
  await eventually(() => {
    const hue = device.capabilitiesObj.light_hue.value;
    assert.ok(hue < 0.01 || hue > 0.99, `Expected red, got hue ${hue}`);
    assert.ok(device.capabilitiesObj.light_saturation.value > 0.99);
  }, 'XY commands must reach the physical color capabilities');
  assert.ok(device.writes.some((write) => {
    return write.capabilityId === 'light_hue' && write.opts.duration === 500;
  }));
  await harness.expectReport(endpoint, 'ColorControl', 'colorMode', 1);

  for (const [command, fields] of [
    ['moveToColor', { colorX: 9830, colorY: 3932, transitionTime: 0 }],
    ['stepColor', { stepX: 100, stepY: 100, transitionTime: 0 }],
    ['moveColor', { rateX: 1000, rateY: 1000 }],
  ]) {
    const before = await harness.read(endpoint, 'ColorControl', 'currentX');
    const attempts = device.attempts;
    device.rejectWrites = true;
    await assert.rejects(harness.invoke(endpoint, 'ColorControl', command, { ...options, ...fields }));
    device.rejectWrites = false;
    assert.ok(device.attempts > attempts, `${command} must attempt a Homey write`);
    assert.equal(await harness.read(endpoint, 'ColorControl', 'currentX'), before);

    device.writes.length = 0;
    await harness.invoke(endpoint, 'ColorControl', command, { ...options, ...fields });
    await eventually(() => {
      assert.ok(device.writes.some((write) => {
        return write.capabilityId === 'light_hue';
      }));
    }, `${command} must control the source`);
    await harness.invoke(endpoint, 'ColorControl', 'stopMoveStep', options);
    const count = device.writes.length;
    await delay(300);
    assert.equal(device.writes.length, count, 'Stop must end both XY transitions');
  }

  await harness.restart();
  assert.equal(harness.endpoint(light.id), endpoint);
  assert.equal(harness.bridge.serverNode.lifecycle.isCommissioned, true);
  await harness.invoke(endpoint, 'ColorControl', 'moveToHueAndSaturation', {
    ...options, hue: 127, saturation: 127, transitionTime: 0,
  });
  await harness.expectReport(endpoint, 'ColorControl', 'currentHue', 127);
  await harness.expectReport(endpoint, 'ColorControl', 'currentSaturation', 127);
  await harness.invoke(endpoint, 'ColorControl', 'moveToColorTemperature', {
    ...options, colorTemperatureMireds: 400, transitionTime: 0,
  });
  await harness.expectReport(endpoint, 'ColorControl', 'colorTemperatureMireds', 400);
});

test('lighting feature commands control the source and preserve rejection behavior', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create([light]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices[light.id];
  const endpoint = harness.endpoint(light.id);
  await harness.invoke(endpoint, 'OnOff', 'offWithEffect', { effectIdentifier: 0, effectVariant: 0 });
  await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
  await harness.invoke(endpoint, 'OnOff', 'onWithRecallGlobalScene', {});
  await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
  await harness.invoke(endpoint, 'OnOff', 'off', {});
  await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
  await harness.invoke(endpoint, 'OnOff', 'onWithTimedOff', {
    onOffControl: { acceptOnlyWhenOn: false }, onTime: 5, offWaitTime: 0,
  });
  await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
  await harness.expectReport(endpoint, 'OnOff', 'onOff', false);

  for (const [command, fields] of [
    ['offWithEffect', { effectIdentifier: 0, effectVariant: 0 }],
    ['onWithRecallGlobalScene', {}],
    ['onWithTimedOff', { onOffControl: { acceptOnlyWhenOn: false }, onTime: 5, offWaitTime: 0 }],
  ]) {
    // Ensure Recall has a saved global scene and must perform an on operation.
    await harness.invoke(endpoint, 'OnOff', 'offWithEffect', { effectIdentifier: 0, effectVariant: 0 });
    device.rejectWrites = true;
    await assert.rejects(harness.invoke(endpoint, 'OnOff', command, fields));
    device.rejectWrites = false;
    assert.equal(await harness.read(endpoint, 'OnOff', 'onOff'), false);
  }
});

test('0.17.9 pairing, controller cache, groups and scenes survive the 0.18 upgrade', { timeout: 60000 }, async (t) => {
  const storageFixture = JSON.parse(await readFile(new URL('./fixtures/matter-0179-retained.json', import.meta.url)));
  const selected = mappings.filter((fixture) => {
    return fixture.id in storageFixture.identities;
  });
  const harness = await BridgeHarness.create(selected, { storageFixture });
  t.after(async () => {
    await harness.close();
  });

  for (const fixture of selected) {
    const old = storageFixture.identities[fixture.id];
    assert.equal(harness.bridge.deviceEndpoints[fixture.id].number, old.parent);
    assert.equal(harness.devices[fixture.id].writes.length, 0, 'Upgrading must not operate physical devices');
    for (const endpoint of old.endpoints) {
      const number = harness.endpoint(fixture.id, endpoint.id);
      assert.equal(number, endpoint.number);
      const types = await harness.read(number, 'Descriptor', 'deviceTypeList');
      assert.deepEqual(types.map((type) => {
        return type.deviceType;
      }), endpoint.deviceTypes.map((type) => {
        return type.deviceType;
      }), 'Keep existing device types even when their specification revision changes');
    }
  }

  const id = 'light-extended-temperature';
  const endpoint = harness.endpoint(id);
  const group = await harness.invoke(endpoint, 'Groups', 'viewGroup', { groupId: 31 });
  assert.ok(group.some((response) => {
    return response.data?.groupName === 'Retained group' && response.data?.status === 0;
  }), 'Retain fabric-scoped group membership');
  const device = harness.devices[id];
  device.emit('dim', 0.25);
  device.emit('light_temperature', 0);
  device.emit('light_mode', 'color');
  await harness.expectReport(endpoint, 'LevelControl', 'currentLevel', 64);
  await harness.expectReport(endpoint, 'ColorControl', 'colorTemperatureMireds', 153);
  await harness.invoke(endpoint, 'ScenesManagement', 'recallScene', { groupId: 31, sceneId: 7, transitionTime: 0 });
  await harness.expectReport(endpoint, 'LevelControl', 'currentLevel', 128);
  await harness.expectReport(endpoint, 'ColorControl', 'colorTemperatureMireds', 277);
  await harness.expectReport(endpoint, 'ColorControl', 'colorMode', 2);
  await harness.restart();
  assert.equal(harness.endpoint(id), endpoint);
  await harness.invoke(endpoint, 'OnOff', 'off', {});
  await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
  assert.deepEqual(harness.errors, []);
});

test('lock commands retain Homey control while honoring the SDK operating-mode checks', { timeout: 15000 }, async (t) => {
  const fixture = mappings.find((item) => {
    return item.id === 'lock-false';
  });
  const harness = await BridgeHarness.create([fixture]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices[fixture.id];
  const endpoint = harness.endpoint(fixture.id);
  const server = [...harness.bridge.deviceEndpointInstances[fixture.id]][0];
  await server.set({ doorLock: {
    supportedOperatingModes: { ...server.state.doorLock.supportedOperatingModes, privacy: false },
    operatingMode: 2, // Privacy
  } });
  await assert.rejects(harness.invoke(endpoint, 'DoorLock', 'lockDoor', {}));
  assert.equal(device.attempts, 0, 'Refused commands must not reach the physical lock');
  await server.set({ doorLock: { operatingMode: 0 } });
  await harness.invoke(endpoint, 'DoorLock', 'lockDoor', {});
  await harness.expectReport(endpoint, 'DoorLock', 'lockState', 1);
  device.rejectWrites = true;
  await assert.rejects(harness.invoke(endpoint, 'DoorLock', 'unlockDoor', {}));
  device.rejectWrites = false;
  assert.equal(await harness.read(endpoint, 'DoorLock', 'lockState'), 1);
});

test('lock state changes only after Homey confirms physical completion', { timeout: 15000 }, async (t) => {
  const fixture = mappings.find((item) => {
    return item.id === 'lock-false';
  });
  const harness = await BridgeHarness.create([fixture]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices[fixture.id];
  const endpoint = harness.endpoint(fixture.id);
  const reportedStates = [];
  harness.onReport = (report) => {
    if (report.path.endpointId === endpoint && report.path.clusterId === 0x101 && report.path.attributeId === 0) {
      reportedStates.push(report.value);
    }
  };
  device.reportWrites = false;

  for (const [command, confirmed, previous, expected] of [
    ['lockDoor', true, 2, 1],
    ['unlockDoor', false, 1, 2],
  ]) {
    reportedStates.length = 0;
    await harness.invoke(endpoint, 'DoorLock', command, {});
    assert.equal(device.writes.at(-1).value, confirmed);
    assert.equal(await harness.read(endpoint, 'DoorLock', 'lockState'), previous);
    await delay(200);
    assert.ok(reportedStates.every((value) => {
      return value === previous;
    }), 'Command acceptance must not publish an unconfirmed state');

    device.emit('locked', confirmed);
    await harness.expectReport(endpoint, 'DoorLock', 'lockState', expected);
  }

  // A command that never receives confirmation must also remain unconfirmed after restart.
  await harness.invoke(endpoint, 'DoorLock', 'lockDoor', {});
  await harness.restart();
  assert.equal(harness.endpoint(fixture.id), endpoint);
  assert.equal(await harness.read(endpoint, 'DoorLock', 'lockState'), 2);
});

test('lighting timers respect manual control and command rejection on every mapping', { timeout: 45000 }, async (t) => {
  const selected = mappings.filter((fixture) => {
    return ['light-extended-color', 'socket', 'fallback'].includes(fixture.id);
  });
  const harness = await BridgeHarness.create(selected);
  t.after(async () => {
    await harness.close();
  });

  for (const fixture of selected) {
    await t.test(fixture.id, async () => {
      const device = harness.devices[fixture.id];
      const endpoint = harness.endpoint(fixture.id);
      const timed = { onOffControl: { acceptOnlyWhenOn: false }, onTime: 10, offWaitTime: 0 };

      await harness.invoke(endpoint, 'OnOff', 'onWithTimedOff', timed);
      await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
      await harness.invoke(endpoint, 'OnOff', 'off', {});
      await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
      await harness.invoke(endpoint, 'OnOff', 'on', {});
      await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
      const manualWrites = device.writes.length;
      await delay(1200);
      assert.equal(device.writes.length, manualWrites, 'Manual off must cancel the previous countdown');
      assert.equal(await harness.read(endpoint, 'OnOff', 'onOff'), true);

      await harness.invoke(endpoint, 'OnOff', 'off', {});
      await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
      device.rejectWrites = true;
      await assert.rejects(harness.invoke(endpoint, 'OnOff', 'onWithTimedOff', timed));
      device.rejectWrites = false;
      await harness.invoke(endpoint, 'OnOff', 'on', {});
      await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
      const acceptedWrites = device.writes.length;
      await delay(1200);
      assert.equal(device.writes.length, acceptedWrites, 'A rejected timed command must not leave an off action');
      assert.equal(await harness.read(endpoint, 'OnOff', 'onOff'), true);

      // Rejecting an extension must not cancel an earlier, successfully requested timer.
      await harness.invoke(endpoint, 'OnOff', 'onWithTimedOff', timed);
      device.rejectWrites = true;
      await assert.rejects(harness.invoke(endpoint, 'OnOff', 'onWithTimedOff', { ...timed, onTime: 30 }));
      device.rejectWrites = false;
      await harness.expectReport(endpoint, 'OnOff', 'onOff', false);

      await harness.invoke(endpoint, 'OnOff', 'onWithTimedOff', timed);
      await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
      device.emit('onoff', false);
      await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
      device.emit('onoff', true);
      await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
      const sourceWrites = device.writes.length;
      await delay(1200);
      assert.equal(device.writes.length, sourceWrites, 'Homey off must also cancel the previous countdown');
      assert.equal(await harness.read(endpoint, 'OnOff', 'onOff'), true);

      // SDK timer bookkeeping must not change the established source-confirmation contract.
      device.reportWrites = false;
      for (const [command, target] of [['off', false], ['on', true]]) {
        await harness.invoke(endpoint, 'OnOff', command, {});
        assert.equal(await harness.read(endpoint, 'OnOff', 'onOff'), !target);
        device.emit('onoff', target);
        await harness.expectReport(endpoint, 'OnOff', 'onOff', target);
      }
      device.reportWrites = true;
    });
  }
});
