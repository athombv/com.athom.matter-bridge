import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { eventually } from './mappings/eventually.mjs';

const readings = [
  ['onoff', 'OnOff', 'onOff', true, false],
  ['alarm_motion', 'OccupancySensing', 'occupancy', { occupied: true }, { occupied: false }],
  ['alarm_occupancy', 'OccupancySensing', 'occupancy', { occupied: true }, { occupied: false }],
  ['alarm_contact', 'BooleanState', 'stateValue', false, true],
  ['alarm_water', 'BooleanState', 'stateValue', true, false],
  ['alarm_smoke', 'SmokeCoAlarm', 'smokeState', 2, 0],
  ['alarm_battery', 'PowerSource', 'batChargeLevel', 1, 0],
];

test('unknown boolean readings stay unavailable until a known reading arrives', { timeout: 60000 }, async (t) => {
  const fixtures = readings.map(([id]) => {
    return {
      id,
      class: 'sensor',
      capabilities: { [id]: { value: null, type: 'boolean' } },
    };
  });
  const harness = await BridgeHarness.create(fixtures);
  t.after(async () => {
    await harness.close();
  });

  for (const [id, cluster, attribute, active, inactive] of readings) {
    const device = harness.devices[id];
    const parent = harness.bridge.deviceEndpoints[id].number;
    let childId = id;

    if (id === 'onoff') {
      childId = 'main';
    } else if (id === 'alarm_battery') {
      childId = 'battery';
    }
    const child = harness.endpoint(id, childId);
    assert.equal(
      await harness.read(parent, 'BridgedDeviceBasicInformation', 'reachable'),
      false,
      'Unknown boolean must be unavailable',
    );

    for (const [value, expected, reachable] of [
      [true, active, true],
      [null, active, false],
      [false, inactive, true],
    ]) {
      device.emit(id, value);
      await eventually(async () => {
        assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'reachable'), reachable);
        assert.deepEqual(await harness.read(child, cluster, attribute), expected);
      }, `${id} handles ${value}`);
      await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'reachable', reachable);
      await harness.expectReport(child, cluster, attribute, expected);
    }
  }

  assert.deepEqual(harness.errors, []);
});

test('mixed water sensors follow source availability without inventing readings', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create([{
    id: 'water-and-temperature',
    class: 'sensor',
    capabilities: {
      alarm_water: { value: true, type: 'boolean' },
      measure_temperature: { value: 21.25, type: 'number', units: '°C' },
    },
  }]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices['water-and-temperature'];
  const parent = harness.bridge.deviceEndpoints[device.id].number;
  const water = harness.endpoint(device.id, 'alarm_water');
  const temperature = harness.endpoint(device.id, 'measure_temperature');
  const setAvailability = async (available, expected) => {
    device.available = available;
    harness.manager.emit('device.update', device);
    await eventually(async () => {
      assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'reachable'), expected);
    }, 'Source availability is advertised');
    await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'reachable', expected);
  };

  assert.equal(await harness.read(water, 'BooleanState', 'stateValue'), true);
  assert.equal(await harness.read(temperature, 'TemperatureMeasurement', 'measuredValue'), 2125);
  await setAvailability(false, false);
  await setAvailability(true, true);

  device.emit('alarm_water', null);
  await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'reachable', false);
  await setAvailability(true, false);
  device.emit('measure_temperature', 22.5);
  await harness.expectReport(temperature, 'TemperatureMeasurement', 'measuredValue', 2250);
  assert.equal(await harness.read(water, 'BooleanState', 'stateValue'), true);
  assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'reachable'), false);

  device.emit('alarm_water', false);
  await harness.expectReport(water, 'BooleanState', 'stateValue', false);
  await harness.expectReport(parent, 'BridgedDeviceBasicInformation', 'reachable', true);
  await harness.restart(() => {
    device.capabilitiesObj.alarm_water.value = null;
  });
  assert.equal(harness.bridge.deviceEndpoints[device.id].number, parent);
  assert.equal(await harness.read(parent, 'BridgedDeviceBasicInformation', 'reachable'), false);
  assert.deepEqual(harness.errors, []);
});

test('incomplete light color capabilities retain basic control without advertising color', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create([{
    id: 'partial-color-light', class: 'light', capabilities: {
      onoff: { value: true, setable: true },
      light_temperature: { value: 0.5, setable: true },
      light_hue: { value: 0.25, setable: true },
      light_mode: { value: 'color' },
    },
  }]);
  t.after(async () => {
    await harness.close();
  });
  const device = harness.devices['partial-color-light'];
  const endpoint = harness.endpoint(device.id);
  const support = harness.bridge.constructor.getDeviceSupport(device);
  assert.deepEqual(support.supportedCapabilities, ['onoff']);
  assert.deepEqual(support.unsupportedCapabilities, ['light_temperature', 'light_hue', 'light_mode']);
  assert.equal((await harness.read(endpoint, 'Descriptor', 'serverList')).includes(768), false);
  assert.equal(await harness.read(endpoint, 'OnOff', 'onOff'), true);
  device.emit('onoff', false);
  await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
  await harness.invoke(endpoint, 'OnOff', 'on');
  await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
  assert.deepEqual(device.writes, [{ capabilityId: 'onoff', value: true }]);
  assert.deepEqual(harness.errors, []);
});
