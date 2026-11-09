import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ControllerBehavior, Environment, Logger, ServerNode } from '@matter/main';
import { Thermostat } from '@matter/main/clusters/thermostat';
import { Read, Write } from '@matter/main/protocol';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

Logger.level = 'error';

class TestThermostat {
  constructor(id, modes) {
    this.id = id;
    this.name = id;
    this.class = 'thermostat';
    this.ready = true;
    this.writes = [];
    this.listeners = new Map();
    this.rejectWrites = false;
    this.capabilitiesObj = {
      target_temperature: { value: 21.5, min: 5, max: 30, step: 0.5 },
      measure_temperature: { value: 20.5 },
    };

    if (modes) {
      this.capabilitiesObj.thermostat_mode = {
        value: 'heat',
        values: modes.map((id) => { return { id }; }),
      };
    }
    if (modes?.includes('cool')) {
      this.capabilitiesObj['target_temperature.cool'] = { value: 24.5, min: 5, max: 30, step: 0.5 };
    }
  }

  async getDriver() {
    return { name: 'Synthetic thermostat', ownerName: 'Test' };
  }

  makeCapabilityInstance(id, callback) {
    this.listeners.set(id, callback);
    return { destroy: () => { this.listeners.delete(id); } };
  }

  async setCapabilityValue(write) {
    if (this.rejectWrites) {
      throw new Error('Thermostat rejected the command');
    }
    this.writes.push(write);
  }

  report(id, value) {
    this.capabilitiesObj[id].value = value;
    assert.ok(this.listeners.has(id), `Missing capability subscription: ${id}`);
    this.listeners.get(id)(value);
  }
}

test('thermostat synchronization does not override Homey schedules', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'thermostat-sync-'));
  const implicit = new TestThermostat('implicit-heat');
  const heating = new TestThermostat('heating', ['off', 'heat']);
  const combined = new TestThermostat('heating-cooling', ['off', 'heat', 'cool', 'auto']);
  const devices = [implicit, heating, combined];
  const devicesById = Object.fromEntries(devices.map((device) => { return [device.id, device]; }));
  const manager = new EventEmitter();
  manager.connect = async () => {};
  manager.getDevices = async () => { return devicesById; };
  const errors = [];
  const discriminator = randomInt(1, 4096);
  const bridge = new MatterBridgeServer({
    api: {
      devices: manager,
      drivers: { connect: async () => {}, getDrivers: async () => { return {}; } },
    },
    debug: (message) => {
      if (message.startsWith('Error')) errors.push(message);
    },
    deviceName: 'Thermostat test', vendorName: 'Test', vendorId: 65521,
    productName: 'Thermostat test', productId: 32768,
    uniqueId: 'thermostat-sync', serialNumber: 'test',
    passcode: 20202021, discriminator, port: 0,
    storageServiceLocation: directory,
    enabledDeviceIds: new Set(Object.keys(devicesById)),
  });
  let controller;
  t.after(async () => {
    try {
      await controller?.peers.close();
      await controller?.close();
    } finally {
      try {
        await bridge.stop();
      } finally {
        await Environment.default.runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  await bridge.start();
  assert.deepEqual(errors, []);

  controller = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
    id: 'thermostat-controller', network: { port: 0 },
  });
  const peer = await controller.peers.commission({
    passcode: 20202021, longDiscriminator: discriminator,
    timeout: 10000, onAttestationFailure: true,
  });
  await peer.start();

  function endpoint(device) {
    const result = [...bridge.deviceEndpointInstances[device.id]].find((item) => {
      return item.id === 'main';
    });
    assert.ok(result);
    return result;
  }

  async function read(device, attribute) {
    const path = {
      endpointId: endpoint(device).number,
      clusterId: Thermostat.Cluster.id,
      attributeId: Thermostat.Cluster.attributes[attribute].id,
    };
    for await (const chunk of peer.interaction.read(Read({ attributes: [path] }))) {
      for (const report of chunk) {
        if (report.kind === 'attr-value') return report.value;
      }
    }
    assert.fail(`Missing thermostat attribute: ${attribute}`);
  }

  async function write(device, attribute, value) {
    const responses = await peer.interaction.write(Write(Write.Attribute({
      endpoint: endpoint(device).number,
      cluster: Thermostat.Cluster,
      attributes: attribute,
      value,
    })));
    for (const response of responses) {
      assert.equal(response.status, 0, 'Controller write must succeed');
    }
  }

  async function report(device, capability, value, attribute, expected) {
    // Await the source update's commit before reading over Matter or checking for echoed commands.
    const changed = new Promise((resolve) => {
      endpoint(device).events.thermostat.stateChanged.once(resolve);
    });
    device.report(capability, value);
    await changed;
    assert.equal(await read(device, attribute), expected);
  }

  await t.test('initialization and commissioning do not command thermostats', () => {
    for (const device of devices) assert.deepEqual(device.writes, []);
  });

  for (const device of [implicit, heating]) {
    await t.test(`${device.id}: schedule changes never become remote overrides`, async () => {
      device.writes = [];
      for (const value of [20, 20.5, 21, 20.5]) {
        await report(device, 'target_temperature', value, 'occupiedHeatingSetpoint', value * 100);
        assert.deepEqual(device.writes, [], 'A Homey setpoint report must not command Homey');
      }
    });
  }

  await t.test('Homey mode changes do not command Homey', async () => {
    heating.writes = [];
    for (const [value, expected] of [['off', Thermostat.SystemMode.Off], ['heat', Thermostat.SystemMode.Heat]]) {
      await report(heating, 'thermostat_mode', value, 'systemMode', expected);
      assert.deepEqual(heating.writes, []);
    }
  });

  await t.test('local cooling-state updates do not command Homey', async () => {
    combined.writes = [];
    // The existing bridge has no cooling capability subscription; exercise its local Matter API.
    await endpoint(combined).set({ thermostat: { occupiedCoolingSetpoint: 2550 } });
    assert.equal(await read(combined, 'occupiedCoolingSetpoint'), 2550);
    assert.deepEqual(combined.writes, []);
  });

  for (const [attribute, capability, value] of [
    ['occupiedHeatingSetpoint', 'target_temperature', 22.5],
    ['occupiedCoolingSetpoint', 'target_temperature.cool', 24.5],
  ]) {
    await t.test(`controller ${attribute} writes preserve fractional temperatures`, async () => {
      combined.writes = [];
      await write(combined, attribute, value * 100);
      assert.deepEqual(combined.writes, [{ capabilityId: capability, value }]);
      assert.equal(await read(combined, attribute), value * 100);
    });
  }

  await t.test('returning to the schedule after a controller write does not override it again', async () => {
    combined.writes = [];
    await write(combined, 'occupiedHeatingSetpoint', 2350);
    assert.deepEqual(combined.writes, [{ capabilityId: 'target_temperature', value: 23.5 }]);
    combined.writes = [];
    await report(combined, 'target_temperature', 20.5, 'occupiedHeatingSetpoint', 2050);
    assert.deepEqual(combined.writes, []);
  });

  await t.test('controller mode writes still reach Homey', async () => {
    combined.writes = [];
    await write(combined, 'systemMode', Thermostat.SystemMode.Off);
    assert.deepEqual(combined.writes, [{ capabilityId: 'thermostat_mode', value: 'off' }]);
    combined.writes = [];
    await report(combined, 'thermostat_mode', 'heat', 'systemMode', Thermostat.SystemMode.Heat);
    assert.deepEqual(combined.writes, []);
  });

  await t.test('rejected controller writes retain the reported state', async () => {
    combined.rejectWrites = true;
    try {
      for (const [attribute, value] of [
        ['occupiedHeatingSetpoint', 2500],
        ['occupiedCoolingSetpoint', 2800],
        ['systemMode', Thermostat.SystemMode.Cool],
      ]) {
        const previous = await read(combined, attribute);
        await assert.rejects(write(combined, attribute, value));
        assert.equal(await read(combined, attribute), previous);
      }
    } finally {
      combined.rejectWrites = false;
    }
  });

  assert.deepEqual(errors, []);
});
