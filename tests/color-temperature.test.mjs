import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Endpoint, Environment, Logger, ServerNode, VendorId } from '@matter/main';
import { AggregatorEndpoint } from '@matter/main/endpoints';
import { BridgedNodeEndpoint } from '@matter/main/endpoints/bridged-node';
import { ExtendedColorLightDevice } from '@matter/main/devices';
import { ColorControlServer } from '@matter/main/behaviors';
import { ColorControl } from '@matter/main/clusters';
import { BridgeCommissioningServer } from '../lib/BridgeCommissioningServer.mjs';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

Logger.level = 'error';

const UNIQUE_ID = 'color-temperature-test';

function makeLight(id, capabilities) {
  const values = [];
  const listeners = {};
  const capabilitiesObj = {};
  for (const [capabilityId, value] of Object.entries(capabilities)) capabilitiesObj[capabilityId] = { value };
  return {
    id, name: 'Light', class: 'light', ready: true, capabilitiesObj, values, listeners,
    getDriver: async () => { return { name: 'Test device', ownerName: 'Test app' }; },
    makeCapabilityInstance: (capabilityId, listener) => {
      listeners[capabilityId] = listener;
      return { destroy: () => {} };
    },
    setCapabilityValue: async ({ capabilityId, value }) => { values.push([capabilityId, value]); },
  };
}

async function startBridge(light, storageServiceLocation) {
  const devices = new EventEmitter();
  devices.connect = async () => {};
  devices.getDevices = async () => { return { [light.id]: light }; };
  const errors = [];
  const bridge = new MatterBridgeServer({
    api: { devices, drivers: { connect: async () => {}, getDrivers: async () => { return {}; } } },
    debug: (message) => { if (String(message).startsWith('Error')) errors.push(message); },
    deviceName: 'Test bridge', vendorName: 'Test', vendorId: 65521,
    productName: 'Test bridge', productId: 32768, uniqueId: UNIQUE_ID, serialNumber: 'test',
    passcode: 20202021, discriminator: 1716, port: 0,
    storageServiceLocation,
    enabledDeviceIds: new Set([light.id]),
  });
  await bridge.start();
  const [endpoint] = bridge.deviceEndpointInstances[light.id];
  return { bridge, endpoint, errors };
}

test('color temperature', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'matter-color-temperature-'));
  t.after(async () => {
    await Environment.default.runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

  await t.test('light_temperature maps onto 6500 K to 2500 K in both directions', async () => {
    const light = makeLight('11111111-1111-4111-8111-111111111111', { onoff: true, dim: 0.5, light_temperature: 0.75 });
    const { bridge, endpoint, errors } = await startBridge(light, directory);
    try {
      assert.deepEqual(errors, []);
      assert.equal(endpoint.state.colorControl.colorTempPhysicalMinMireds, 153); // 6500 K
      assert.equal(endpoint.state.colorControl.colorTempPhysicalMaxMireds, 400); // 2500 K
      assert.equal(endpoint.state.colorControl.coupleColorTempToLevelMinMireds, 153);
      assert.equal(endpoint.state.colorControl.colorTemperatureMireds, 338); // 0.75 is warm

      // Source reports cover both boundaries, rounding and an unknown reading.
      for (const [value, expected] of [[0, 153], [1, 400], [0.5, 277], [null, 250]]) {
        const changed = new Promise((resolve) => {
          endpoint.events.colorControl.stateChanged.once(resolve);
        });

        light.listeners.light_temperature(value);
        await changed;
        assert.equal(endpoint.state.colorControl.colorTemperatureMireds, expected);
      }

      for (const [mireds, expected] of [[153, 0], [370, 217 / 247], [400, 1]]) {
        light.values.length = 0;
        await endpoint.act(async (agent) => {
          await agent.colorControl.moveToColorTemperature({
            colorTemperatureMireds: mireds, transitionTime: 0, optionsMask: {}, optionsOverride: {},
          });
        });
        const [, temperature] = light.values.find(([capabilityId]) => {
          return capabilityId === 'light_temperature';
        });
        assert.ok(Math.abs(temperature - expected) < 0.0001, `light_temperature ${temperature}`);
      }
    } finally {
      await bridge.stop();
    }
  });

  for (const [index, value] of [null, undefined].entries()) {
    await t.test(`unknown initial temperature (${String(value)}) uses an in-range fallback`, async () => {
      const light = makeLight(`unknown-temperature-${index}`, { onoff: true, dim: 0.5, light_temperature: value });
      const { bridge, endpoint, errors } = await startBridge(light, directory);

      try {
        assert.deepEqual(errors, []);
        assert.equal(endpoint.state.colorControl.colorTemperatureMireds, 250);
      } finally {
        await bridge.stop();
      }
    });
  }

  await t.test('a color temperature stored with the earlier 1–300 mired range doesn\'t break the light', async () => {
    const id = '22222222-2222-4222-8222-222222222222';

    // Store a color temperature of 1 mired, as the earlier mapping did for light_temperature 0
    Environment.default.vars.set('storage.path', directory);
    const node = await ServerNode.create(ServerNode.RootEndpoint.with(BridgeCommissioningServer), {
      id: UNIQUE_ID,
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 1716 },
      productDescription: { name: 'Test bridge', deviceType: AggregatorEndpoint.deviceType },
      basicInformation: { vendorName: 'Test', vendorId: VendorId(65521), productName: 'Test bridge', productId: 32768, serialNumber: 'test', uniqueId: UNIQUE_ID },
    });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
    await node.add(aggregator);
    const bridged = new Endpoint(BridgedNodeEndpoint, { id, bridgedDeviceBasicInformation: { nodeLabel: 'Light' } });
    await aggregator.add(bridged);
    const old = new Endpoint(ExtendedColorLightDevice.with(
      ColorControlServer.with(ColorControl.Feature.HueSaturation, ColorControl.Feature.ColorTemperature),
    ), {
      id: 'main',
      colorControl: {
        colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
        currentHue: 0,
        currentSaturation: 0,
        colorTemperatureMireds: 150,
        colorTempPhysicalMinMireds: 1,
        colorTempPhysicalMaxMireds: 300,
        coupleColorTempToLevelMinMireds: 1,
      },
    });
    await bridged.add(old);
    await node.start();
    await old.set({ colorControl: { colorTemperatureMireds: 1 } });
    const originalEndpointNumber = old.number;
    await node.close();

    // The light is now in color mode, which doesn't set a color temperature itself
    const light = makeLight(id, {
      onoff: true, dim: 0.5, light_hue: 0.5, light_saturation: 0.5, light_temperature: 0, light_mode: 'color',
    });
    const { bridge, endpoint, errors } = await startBridge(light, directory);
    try {
      assert.deepEqual(errors, []);
      assert.equal(endpoint.lifecycle.isReady, true);
      assert.equal(endpoint.number, originalEndpointNumber);
      assert.deepEqual(light.values, [], 'Migration must not command the source device');
      // The stored 1 mired is kept within the range; without a stored value it would be the default of 250
      assert.equal(endpoint.state.colorControl.colorTemperatureMireds, 153);
      await endpoint.act((agent) => { return agent.onOff.off(); });
    } finally {
      await bridge.stop();
    }
  });
});
