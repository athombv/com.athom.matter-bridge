import assert from 'node:assert/strict';
import test from 'node:test';
import { OnOff } from '@matter/main/clusters/on-off';
import { LevelControl } from '@matter/main/clusters/level-control';
import { ElectricalPowerMeasurement } from '@matter/main/clusters/electrical-power-measurement';
import { Thermostat } from '@matter/main/clusters/thermostat';
import { createBridge } from './support/bridge.mjs';
import { eventually } from './support/eventually.mjs';

test('restart restores current Homey state without re-pairing or sending device commands', { timeout: 150000 }, async (t) => {
  const { homey, matter, light, byType, devices } = await createBridge(t, {
    types: ['light', 'socket-power', 'thermostat'],
  });
  const socket = byType['socket-power'];
  const thermostat = byType.thermostat;
  const onOff = await matter.path(light, OnOff.Cluster, 'onOff');
  const level = await matter.path(light, LevelControl.Cluster, 'currentLevel');
  const power = await matter.path(socket, ElectricalPowerMeasurement.Cluster, 'activePower');
  const setpoint = await matter.path(thermostat, Thermostat.Cluster, 'occupiedHeatingSetpoint');

  // Establish values that differ from the changes made while the bridge is off.
  await matter.expectUpdate(homey, light, 'onoff', true, OnOff.Cluster, 'onOff', true);
  await matter.expectUpdate(homey, light, 'dim', 1, LevelControl.Cluster, 'currentLevel', 254);
  assert.equal(await matter.value(power), 12000);

  for (const [cycle, values] of [
    { onoff: false, dim: 0.25, level: 64, power: null, setpoint: 22.5 },
    { onoff: true, dim: 0.75, level: 190, power: 7.25, setpoint: 19.5 },
  ].entries()) {
    const previousName = light.name;
    await matter.disconnect();

    try {
      await homey.stopBridge();
      await homey.report(light, { onoff: values.onoff, dim: values.dim });
      await homey.report(socket, { measure_power: values.power });
      await homey.report(thermostat, { target_temperature: values.setpoint });
      light.name = `Restart light ${cycle + 1}`;
      await homey.request(`/manager/devices/device/${light.id}`, { method: 'PUT', body: { name: light.name } });

      for (const device of devices) {
        await homey.control(device, { operation: 'clear-commands' });
      }
    } finally {
      // Keep cleanup possible even when a backend assertion fails while stopped.
      await homey.startBridge();
      await matter.reconnect();
    }

    // First reads, before any post-startup source update, use the original paths.
    assert.equal(await matter.value(onOff), values.onoff, 'Restart must restore current on/off state');
    assert.equal(await matter.value(level), values.level, 'Restart must restore current dim level');
    assert.equal(await matter.value(power), values.power === null ? null : values.power * 1000);
    assert.equal(await matter.value(setpoint), values.setpoint * 100);
    assert.deepEqual(await matter.path(light, OnOff.Cluster, 'onOff'), onOff);
    assert.equal(await matter.endpoint(previousName), undefined, 'Old label must not survive the restart');

    for (const device of devices) {
      assert.deepEqual((await homey.fixture(device)).commands, [], 'Restoring state must not command Homey devices');
    }

    await matter.expectUpdate(homey, light, 'dim', 1, LevelControl.Cluster, 'currentLevel', 254);
    await matter.command(light, OnOff.Cluster, 'off');
    await eventually('Matter commands still reach Homey after restart', async () => {
      return await homey.value(light.id, 'onoff');
    }, false);
    t.diagnostic(`Restart ${cycle + 1}: retained pairing, current values, renamed label, subscription and command checked`);
  }
});
