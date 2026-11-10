import assert from 'node:assert/strict';
import test from 'node:test';
import { ColorControl } from '@matter/main/clusters/color-control';
import { createBridge } from './support/bridge.mjs';
import { eventually } from './support/eventually.mjs';

test('color temperature uses the Homey fallback range in both directions', { timeout: 120000 }, async (t) => {
  const types = ['light-temperature', 'light-extended', 'light-extended-temperature'];
  const { homey, matter, byType } = await createBridge(t, { types });
  const cluster = ColorControl.Cluster;

  for (const type of types) {
    await t.test(type, async () => {
      const device = byType[type];
      const minPath = await matter.path(device, cluster, 'colorTempPhysicalMinMireds');
      const maxPath = await matter.path(device, cluster, 'colorTempPhysicalMaxMireds');
      const coupledMinPath = await matter.path(device, cluster, 'coupleColorTempToLevelMinMireds');
      const temperaturePath = await matter.path(device, cluster, 'colorTemperatureMireds');

      assert.equal(await matter.value(minPath), 153);
      assert.equal(await matter.value(maxPath), 400);
      assert.equal(await matter.value(coupledMinPath), 153);

      // Verify reports on the original subscription, including unknown and recovered values.
      for (const [source, expected] of [[0, 153], [1, 400], [null, 250], [0.75, 338]]) {
        await matter.expectUpdate(homey, device, 'light_temperature', source, cluster, 'colorTemperatureMireds', expected, { report: true });
      }

      // SHS applies the standard capability's two-decimal precision before calling the driver.
      for (const [requestedMireds, expectedHomey, expectedMireds] of [[153, 0, 153], [370, 0.88, 370], [400, 1, 400]]) {
        await homey.control(device, { operation: 'clear-commands' });
        await matter.command(device, cluster, 'moveToColorTemperature', {
          colorTemperatureMireds: requestedMireds,
          transitionTime: 0,
          optionsMask: {},
          optionsOverride: {},
        });
        const fixture = await homey.fixture(device);
        const command = fixture.commands.find((entry) => {
          return entry.capability === 'light_temperature';
        });

        assert.deepEqual(command, { capability: 'light_temperature', value: expectedHomey, accepted: true });
        assert.equal(await homey.value(device.id, 'light_temperature'), expectedHomey);
        await eventually('Acknowledged temperature must return over Matter', async () => {
          return await matter.value(temperaturePath);
        }, expectedMireds);
      }
    });
  }
});
