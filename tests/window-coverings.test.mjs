import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Environment, Logger } from '@matter/main';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

Logger.level = 'error';

const OPEN = 0;
const CLOSED = 10000;

test('state-only window coverings accept position commands', { timeout: 30000 }, async (t) => {
  const commands = [];
  const listeners = {};
  const device = {
    id: 'state-cover', name: 'state-cover', class: 'windowcoverings', ready: true,
    capabilitiesObj: { windowcoverings_state: { value: 'idle' } },
    getDriver: async () => { return { name: 'Test device', ownerName: 'Test app' }; },
    makeCapabilityInstance: (capabilityId, listener) => {
      listeners[capabilityId] = listener;
      return { destroy: () => {} };
    },
    setCapabilityValue: async ({ value }) => { commands.push(value); },
  };

  const devices = new EventEmitter();
  devices.connect = async () => {};
  devices.getDevices = async () => { return { [device.id]: device }; };
  const directory = await mkdtemp(join(tmpdir(), 'matter-window-coverings-'));
  const errors = [];
  const bridge = new MatterBridgeServer({
    api: { devices, drivers: { connect: async () => {}, getDrivers: async () => { return {}; } } },
    debug: (message) => {
      if (message.startsWith('Error')) errors.push(message);
    },
    deviceName: 'Test bridge', vendorName: 'Test', vendorId: 65521,
    productName: 'Test bridge', productId: 32768, uniqueId: 'window-coverings-test', serialNumber: 'test',
    passcode: 20202021, discriminator: 1710, port: 0,
    storageServiceLocation: directory,
    enabledDeviceIds: new Set([device.id]),
  });
  t.after(async () => {
    await bridge.stop();
    await Environment.default.runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  await bridge.start();
  assert.deepEqual(errors, []);

  const [endpoint] = bridge.deviceEndpointInstances[device.id];
  const position = () => {
    const { targetPositionLiftPercent100ths, currentPositionLiftPercent100ths } = endpoint.state.windowCovering;
    return [targetPositionLiftPercent100ths, currentPositionLiftPercent100ths];
  };

  assert.deepEqual(position(), [OPEN, OPEN]);

  await endpoint.act((agent) => agent.windowCovering.goToLiftPercentage({ liftPercent100thsValue: 8000 }));
  assert.deepEqual(commands, ['down']);
  assert.deepEqual(position(), [CLOSED, CLOSED]);

  await endpoint.act((agent) => agent.windowCovering.goToLiftPercentage({ liftPercent100thsValue: 2000 }));
  assert.deepEqual(commands, ['down', 'up']);
  assert.deepEqual(position(), [OPEN, OPEN]);

  await endpoint.act((agent) => agent.windowCovering.downOrClose());
  await endpoint.act((agent) => agent.windowCovering.stopMotion());
  assert.deepEqual(commands, ['down', 'up', 'down', 'idle']);
  assert.deepEqual(position(), [CLOSED, CLOSED]);

  listeners.windowcoverings_state('up');
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.deepEqual(position(), [OPEN, OPEN]);
});
