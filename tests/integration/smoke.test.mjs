import test from 'node:test';
import { OnOff } from '@matter/main/clusters/on-off';
import { LevelControl } from '@matter/main/clusters/level-control';
import { createBridge } from './support/bridge.mjs';
import { eventually } from './support/eventually.mjs';

test('installed bridge carries Homey updates, Matter reports and controller commands', { timeout: 90000 }, async (t) => {
  const { homey, matter, light, socket } = await createBridge(t);
  await matter.expectUpdate(homey, light, 'onoff', true, OnOff.Cluster, 'onOff', true);
  await matter.expectUpdate(homey, light, 'dim', 1, LevelControl.Cluster, 'currentLevel', 254);
  await matter.expectUpdate(homey, light, 'dim', 0.25, LevelControl.Cluster, 'currentLevel', 64);
  await matter.expectUpdate(homey, socket, 'onoff', true, OnOff.Cluster, 'onOff', true);
  await matter.command(light, OnOff.Cluster, 'off');
  await eventually('Matter off command must update the Homey backend', async () => {
    return await homey.value(light.id, 'onoff');
  }, false);
  await homey.share(light.id, false);
  await eventually('Unsharing must remove the light from Matter discovery', async () => {
    return await matter.endpoint(light.name);
  }, undefined);
  await matter.expectUpdate(homey, socket, 'onoff', false, OnOff.Cluster, 'onOff', false);
});
