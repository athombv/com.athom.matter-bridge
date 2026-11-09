import assert from 'node:assert/strict';
import test from 'node:test';
import { OnOff } from '@matter/main/clusters/on-off';
import { LevelControl } from '@matter/main/clusters/level-control';
import { createBridge } from './support/bridge.mjs';
import { eventually } from './support/eventually.mjs';

test('re-sharing restores live updates without replacing the controller subscription', { timeout: 90000 }, async (t) => {
  const { homey, matter, light, socket } = await createBridge(t);
  await matter.expectUpdate(homey, light, 'onoff', true, OnOff.Cluster, 'onOff', true);
  await matter.expectUpdate(homey, light, 'dim', 1, LevelControl.Cluster, 'currentLevel', 254);
  const socketEndpoint = await matter.endpoint(socket.name);

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await homey.share(light.id, false);
    await eventually('Unsharing removes the endpoint', async () => {
      return await matter.endpoint(light.name);
    }, undefined);
    await homey.set(light.id, 'onoff', false);
    await homey.set(light.id, 'dim', 0.5);
    await homey.share(light.id, false);
    await homey.share(light.id, true);
    await homey.share(light.id, true);
    await eventually('Re-sharing recreates the endpoint', async () => {
      return (await matter.endpoint(light.name)) !== undefined;
    }, true);

    // Stored Matter values may win during recreation (the separate #33 issue).
    // First synchronize both sides, then demand push reports for real transitions.
    const onOff = await matter.path(light, OnOff.Cluster, 'onOff');
    t.diagnostic(`Cycle ${cycle}: initial backend=false, Matter=${await matter.value(onOff)}`);
    await homey.set(light.id, 'onoff', true);
    await eventually('Re-shared light must receive new Homey on/off updates', async () => {
      return await matter.value(onOff);
    }, true);
    const level = await matter.path(light, LevelControl.Cluster, 'currentLevel');
    await homey.set(light.id, 'dim', 1);
    await eventually('Re-shared light must receive new Homey dim updates', async () => {
      return await matter.value(level);
    }, 254);

    await matter.expectUpdate(homey, light, 'onoff', false, OnOff.Cluster, 'onOff', false);
    await matter.expectUpdate(homey, light, 'dim', 0.25, LevelControl.Cluster, 'currentLevel', 64);
    await matter.expectUpdate(homey, light, 'onoff', true, OnOff.Cluster, 'onOff', true);
    await matter.expectUpdate(homey, light, 'dim', 1, LevelControl.Cluster, 'currentLevel', 254);
    await matter.expectUpdate(homey, socket, 'onoff', cycle % 2 === 1, OnOff.Cluster, 'onOff', cycle % 2 === 1);
    assert.equal(await matter.endpoint(socket.name), socketEndpoint);
    await matter.command(light, OnOff.Cluster, 'off');
    await eventually('Controller command must still reach Homey after re-sharing', async () => {
      return await homey.value(light.id, 'onoff');
    }, false);
    t.diagnostic(`Cycle ${cycle}: live reads, push reports, controller command and unaffected socket passed`);
  }
});
