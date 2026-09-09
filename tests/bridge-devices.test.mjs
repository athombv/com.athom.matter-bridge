import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Environment, Logger } from '@matter/main';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

Logger.level = 'error';

test('all supported Homey device mappings initialize with the current Matter model', { timeout: 30000 }, async (t) => {
  const definitions = [
    ['socket', 'socket', { onoff: true, measure_power: 12 }],
    ['light', 'light', { onoff: true }],
    ['dimmable', 'light', { onoff: true, dim: 0.5 }],
    ['color', 'light', { onoff: true, dim: 0.5, light_hue: 0.5, light_saturation: 0.5 }],
    ['temperature', 'light', { onoff: true, dim: 0.5, light_temperature: 0.5 }],
    ['extended-color', 'light', { onoff: true, dim: 0.5, light_hue: 0.5, light_saturation: 0.5, light_temperature: 0.5, light_mode: 'color' }],
    ['extended-temperature', 'light', { onoff: true, dim: 0.5, light_hue: 0.5, light_saturation: 0.5, light_temperature: 0.5, light_mode: 'temperature' }],
    ['thermostat', 'thermostat', { target_temperature: 21, measure_temperature: 20 }],
    ['airconditioning', 'airconditioning', { thermostat_mode: 'heat', target_temperature: 21, 'target_temperature.cool': 24, measure_temperature: 20, measure_humidity: 50 }],
    ['lock', 'lock', { locked: false }],
    ['position-cover', 'windowcoverings', { windowcoverings_set: 0.5 }],
    ['state-cover', 'windowcoverings', { windowcoverings_state: 'idle' }],
    ['other', 'other', { onoff: true }],
  ];
  const sensorValues = {
    measure_temperature: 20, measure_humidity: 50, measure_co: 0, measure_co2: 400,
    measure_pm10: 10, measure_pm25: 5, measure_luminance: 100,
    alarm_motion: false, alarm_occupancy: false, alarm_contact: false, alarm_smoke: false,
  };
  for (const [capability, value] of Object.entries(sensorValues)) {
    definitions.push([capability, 'sensor', { [capability]: value }]);
  }

  const devicesById = {};
  for (const [id, deviceClass, values] of definitions) {
    const capabilitiesObj = {};
    for (const [capability, value] of Object.entries(values)) {
      capabilitiesObj[capability] = { value };
    }
    if (capabilitiesObj.thermostat_mode) {
      capabilitiesObj.thermostat_mode.values = ['off', 'heat', 'cool', 'auto'].map((id) => {
        return { id };
      });
    }
    devicesById[id] = {
      id, name: id, class: deviceClass, ready: true, capabilitiesObj,
      getDriver: async () => { return { name: 'Test device', ownerName: 'Test app' }; },
      makeCapabilityInstance: () => { return { destroy: () => {} }; },
      setCapabilityValue: async () => {},
    };
  }

  const devices = new EventEmitter();
  devices.connect = async () => {};
  devices.getDevices = async () => { return devicesById; };
  const directory = await mkdtemp(join(tmpdir(), 'matter-device-models-'));
  const errors = [];
  const bridge = new MatterBridgeServer({
    api: { devices, drivers: { connect: async () => {}, getDrivers: async () => { return {}; } } },
    debug: (message) => {
      if (message.startsWith('Error')) errors.push(message);
    },
    deviceName: 'Test bridge', vendorName: 'Test', vendorId: 65521,
    productName: 'Test bridge', productId: 32768, uniqueId: 'device-model-test', serialNumber: 'test',
    passcode: 20202021, discriminator: 1709, port: 0,
    storageServiceLocation: directory,
    enabledDeviceIds: new Set(Object.keys(devicesById)),
  });
  t.after(async () => {
    await bridge.stop();
    await Environment.default.runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  await bridge.start();

  assert.deepEqual(errors, []);
  for (const [id] of definitions) {
    const endpoints = bridge.deviceEndpointInstances[id];
    assert.ok(endpoints?.size > 0, `${id} has a Matter endpoint`);
    for (const endpoint of endpoints) {
      assert.equal(endpoint.lifecycle.isReady, true, `${id}/${endpoint.id} is ready`);
    }
  }
});
