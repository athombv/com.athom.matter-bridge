import assert from 'node:assert/strict';
import test from 'node:test';
import { ElectricalPowerMeasurement } from '@matter/main/clusters/electrical-power-measurement';
import { OnOff } from '@matter/main/clusters/on-off';
import { createBridge } from './support/bridge.mjs';
import { eventually } from './support/eventually.mjs';

test('power readings initialize in milliwatts and tolerate an unknown reading', { timeout: 120000 }, async (t) => {
  const { homey, matter, devices, byType } = await createBridge(t, { types: ['socket-power'] });
  const cluster = ElectricalPowerMeasurement.Cluster;

  await t.test('the first Matter read converts the existing Homey reading', async () => {
    const socket = byType['socket-power'];
    assert.equal(await homey.value(socket.id, 'measure_power'), 12);
    const path = await matter.path(socket, cluster, 'activePower');
    assert.equal(await matter.value(path), 12000, '12 W must initially be exposed as 12000 mW');
  });

  await t.test('a socket paired while the bridge runs works before its first power report', async () => {
    const socket = await homey.createDevice('socket-power-unset', 'Live power socket');
    devices.push(socket);
    assert.equal(await homey.value(socket.id, 'measure_power'), null);
    await homey.share(socket.id, true);
    await eventually('A socket without a power reading must initialize its Matter endpoint', async () => {
      return (await matter.endpoint(socket.name, cluster.id)) !== undefined;
    }, true);

    const path = await matter.path(socket, cluster, 'activePower');
    assert.equal(await matter.value(path), null, 'Unknown power must remain unknown, not zero');
    await matter.command(socket, OnOff.Cluster, 'on');
    await eventually('The new socket must accept commands before reporting power', async () => {
      return await homey.value(socket.id, 'onoff');
    }, true);

    for (const [watts, milliwatts] of [[12.35, 12350], [0, 0], [-1.25, -1250], [null, null], [12, 12000]]) {
      await matter.expectUpdate(homey, socket, 'measure_power', watts, cluster, 'activePower', milliwatts, { report: true });
    }
  });
});
