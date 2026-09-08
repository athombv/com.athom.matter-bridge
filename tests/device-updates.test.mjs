import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ServerNode } from '@matter/main';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

test('device-only updates initialize selected devices when ready and ignore subsequent updates', async (t) => {
  const device = { id: 'lamp', name: 'Test lamp', ready: false };
  const devices = new EventEmitter();
  devices.connect = async () => {};
  devices.getDevices = async () => { return { lamp: device }; };
  const server = new MatterBridgeServer({
    api: { devices, drivers: { connect: async () => {}, getDrivers: async () => { return {}; } } },
    debug: () => {},
    enabledDeviceIds: new Set([device.id]),
  });
  t.mock.method(ServerNode, 'create', async () => {
    return { add: async () => {}, start: async () => {}, close: async () => {} };
  });
  const endpoints = [];
  const initialized = [];
  t.mock.method(server, '__initEndpoint', async (updatedDevice) => { endpoints.push(updatedDevice.id); });
  t.mock.method(server, '__initDevice', async (updatedDevice) => {
    initialized.push(updatedDevice.id);
    server.deviceEndpointInstances[updatedDevice.id] = new Set();
  });

  await server.start();
  t.after(async () => { await server.stop(); });
  assert.deepEqual(endpoints, ['lamp']);
  assert.deepEqual(initialized, []);

  assert.doesNotThrow(() => { devices.emit('device.update', device); });
  devices.emit('device.update', { id: 'unselected', ready: true });
  assert.deepEqual(initialized, []);

  device.ready = true;
  assert.doesNotThrow(() => { devices.emit('device.update', device); });
  assert.deepEqual(initialized, ['lamp']);

  devices.emit('device.update', { ...device, name: 'Renamed lamp' });
  devices.emit('device.update', { ...device, ready: false });
  devices.emit('device.update', device);
  assert.deepEqual(initialized, ['lamp']);
  assert.deepEqual(endpoints, ['lamp']);
});
