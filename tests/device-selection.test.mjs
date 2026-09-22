import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { MatterBridgeServer } from '../lib/MatterBridgeServer.mjs';

// The Homey runtime supplies this framework class on the hub. Mock only that import.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'homey') {
      return { url: 'data:text/javascript,export default { App: class {} }', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { default: MatterBridgeApp } = await import('../lib/MatterBridgeApp.mjs');
hooks.deregister();

function createApp() {
  const app = new MatterBridgeApp();
  let selected = [];
  app.homey = {
    settings: {
      get: async () => {
        return [...selected];
      },
      set: async (key, value) => {
        assert.equal(key, 'enabledDeviceIds');
        selected = [...value];
      },
    },
  };
  app.server = { enableDevice: async () => {}, disableDevice: async () => {} };
  return app;
}

test('concurrent device selections preserve every successful selection', async () => {
  const app = createApp();
  let finish;
  app.server.enableDevice = async (id) => {
    if (id === 'first') {
      await new Promise((resolve) => {
        finish = resolve;
      });
    }
  };
  const first = app.onAPIEnableDevice({ deviceId: 'first' });
  const second = app.onAPIEnableDevice({ deviceId: 'second' });
  // Reading settings yields until the first queued operation reaches the server.
  assert.deepEqual([...await app.getEnabledDeviceIds()], []);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual([...await app.getEnabledDeviceIds()], ['first', 'second']);

  await Promise.all([
    app.onAPIDisableDevice({ deviceId: 'first' }),
    app.onAPIEnableDevice({ deviceId: 'third' }),
  ]);
  assert.deepEqual([...await app.getEnabledDeviceIds()], ['second', 'third']);
});

test('failed selections are not persisted and do not block later selections', async () => {
  const app = createApp();
  app.server.enableDevice = async (id) => {
    if (id === 'unsupported') {
      throw new Error('No supported capabilities');
    }
  };
  await assert.rejects(app.onAPIEnableDevice({ deviceId: 'unsupported' }), /No supported/);
  await app.onAPIEnableDevice({ deviceId: 'supported' });
  assert.deepEqual([...await app.getEnabledDeviceIds()], ['supported']);
});

test('support classification accounts for class-specific omissions and virtual classes', () => {
  const support = (deviceClass, capabilitiesObj, virtualClass) => {
    return MatterBridgeServer.getDeviceSupport({ class: deviceClass, capabilitiesObj, virtualClass });
  };
  assert.deepEqual(support('sensor', { measure_power: {}, meter_power: {} }), {
    canShare: true, supportedCapabilities: ['measure_power', 'meter_power'], unsupportedCapabilities: [],
  });
  assert.deepEqual(support('fan', { onoff: {}, swing_mode: {} }), {
    canShare: true, supportedCapabilities: ['onoff'], unsupportedCapabilities: ['swing_mode'],
  });
  assert.deepEqual(support('sensor', { alarm_water: {}, measure_temperature: {}, measure_battery: {} }), {
    canShare: true, supportedCapabilities: ['alarm_water', 'measure_temperature', 'measure_battery'],
    unsupportedCapabilities: [],
  });
  assert.deepEqual(support('socket', { onoff: {}, dim: {}, measure_power: {} }, 'light'), {
    canShare: true, supportedCapabilities: ['onoff', 'dim', 'measure_power'], unsupportedCapabilities: [],
  });
});

test('API describes capability support without omitting existing unsupported selections', async () => {
  const app = createApp();
  await app.homey.settings.set('enabledDeviceIds', ['camera']);
  app.api = { devices: { getDevices: async () => {
    return {
      camera: {
        id: 'camera', name: 'Camera', class: 'camera', flags: [],
        capabilitiesObj: { alarm_generic: { title: 'Alarm' } },
        getZone: async () => { return null; },
      },
    };
  } } };
  const devices = await app.onAPIGetDevices();
  assert.equal(devices[0].isSelected, true);
  assert.deepEqual(devices[0].support, {
    canShare: false, supportedCapabilities: [],
    unsupportedCapabilities: [{ id: 'alarm_generic', title: 'Alarm' }],
  });
});
