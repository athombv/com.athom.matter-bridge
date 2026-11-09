import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ControllerBehavior, Environment, Logger, ServerNode } from '@matter/main';
import { OnOff } from '@matter/main/clusters/on-off';
import { LevelControl } from '@matter/main/clusters/level-control';
import { Read } from '@matter/main/protocol';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

Logger.level = 'error';

class TestLight extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.name = id;
    this.class = 'light';
    this.ready = true;
    this.capabilitiesObj = {
      onoff: { value: false },
      dim: { value: 0.5 },
    };
  }

  async getDriver() {
    return { name: 'Synthetic light', ownerName: 'Test' };
  }

  makeCapabilityInstance(capabilityId, listener) {
    this.on(capabilityId, listener);

    return {
      destroy: () => {
        this.off(capabilityId, listener);
      },
    };
  }

  report(capabilityId, value) {
    this.capabilitiesObj[capabilityId].value = value;
    this.emit(capabilityId, value);
  }
}

test('sharing a device again restores Homey updates without duplicate listeners', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'matter-device-reshare-'));
  const light = new TestLight('reshared-light');
  const other = new TestLight('unchanged-light');
  const devicesById = { [light.id]: light, [other.id]: other };
  const devices = new EventEmitter();
  devices.connect = async () => {};
  devices.getDevices = async () => {
    return devicesById;
  };
  devices.getDevice = async ({ id }) => {
    return devicesById[id];
  };

  const errors = [];
  const discriminator = randomInt(1, 4096);
  const bridge = new MatterBridgeServer({
    api: {
      devices,
      drivers: {
        connect: async () => {},
        getDrivers: async () => {
          return {};
        },
      },
    },
    debug: (message) => {
      if (message.startsWith('Error')) {
        errors.push(message);
      }
    },
    deviceName: 'Reshare test', vendorName: 'Test', vendorId: 65521,
    productName: 'Reshare test', productId: 32768,
    uniqueId: 'device-reshare-test', serialNumber: 'test',
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
    id: 'reshare-controller', network: { port: 0 },
  });
  const peer = await controller.peers.commission({
    passcode: 20202021, longDiscriminator: discriminator,
    timeout: 10000, onAttestationFailure: true,
  });
  await peer.start();

  async function reportAndRead(device, capabilityId, value, behavior, cluster, attribute, expected) {
    const [endpoint] = bridge.deviceEndpointInstances[device.id];
    const changed = new Promise((resolve) => {
      endpoint.events[behavior].stateChanged.once(resolve);
    });

    device.report(capabilityId, value);
    await changed;

    const path = {
      endpointId: endpoint.number,
      clusterId: cluster.id,
      attributeId: cluster.attributes[attribute].id,
    };

    for await (const chunk of peer.interaction.read(Read({ attributes: [path] }))) {
      for (const report of chunk) {
        if (report.kind === 'attr-value') {
          assert.equal(report.value, expected);
          return;
        }
      }
    }

    assert.fail(`Missing Matter attribute: ${attribute}`);
  }

  const [otherEndpoint] = bridge.deviceEndpointInstances[other.id];

  for (let cycle = 1; cycle <= 3; cycle++) {
    await t.test(`unshare and share cycle ${cycle}`, async () => {
      await bridge.disableDevice(light.id);

      for (const capabilityId of ['onoff', 'dim']) {
        assert.equal(light.listenerCount(capabilityId), 0, 'Unsharing must detach every source listener');
        assert.equal(other.listenerCount(capabilityId), 1, 'Other devices must stay subscribed');
      }

      assert.equal(bridge.deviceEndpoints[light.id], undefined);
      assert.equal(bridge.deviceEndpointInstances[light.id], undefined);
      assert.equal(bridge.deviceCapabilityInstances[light.id], undefined);

      // Source changes while unshared must not try to update a deleted endpoint.
      light.report('onoff', false);
      light.report('dim', 0.5);
      await bridge.disableDevice(light.id);
      await bridge.enableDevice(light.id);
      await bridge.enableDevice(light.id);

      for (const capabilityId of ['onoff', 'dim']) {
        assert.equal(light.listenerCount(capabilityId), 1, 'Sharing must attach exactly one fresh listener');
      }

      await reportAndRead(light, 'onoff', true, 'onOff', OnOff.Cluster, 'onOff', true);
      await reportAndRead(light, 'dim', 1, 'levelControl', LevelControl.Cluster, 'currentLevel', 254);

      const otherValue = cycle % 2 === 1;
      await reportAndRead(other, 'onoff', otherValue, 'onOff', OnOff.Cluster, 'onOff', otherValue);
      assert.equal([...bridge.deviceEndpointInstances[other.id]][0], otherEndpoint);
      assert.deepEqual(errors, []);
    });
  }
});
