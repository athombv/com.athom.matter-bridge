import assert from 'node:assert/strict';
import test from 'node:test';
import { Status, StatusResponseError } from '@matter/main/types';
import { OnOff } from '@matter/main/clusters/on-off';
import { LevelControl } from '@matter/main/clusters/level-control';
import { ColorControl } from '@matter/main/clusters/color-control';
import { Thermostat } from '@matter/main/clusters/thermostat';
import { DoorLock } from '@matter/main/clusters/door-lock';
import { WindowCovering } from '@matter/main/clusters/window-covering';
import { TemperatureMeasurement } from '@matter/main/clusters/temperature-measurement';
import { RelativeHumidityMeasurement } from '@matter/main/clusters/relative-humidity-measurement';
import { CarbonMonoxideConcentrationMeasurement } from '@matter/main/clusters/carbon-monoxide-concentration-measurement';
import { CarbonDioxideConcentrationMeasurement } from '@matter/main/clusters/carbon-dioxide-concentration-measurement';
import { Pm10ConcentrationMeasurement } from '@matter/main/clusters/pm10-concentration-measurement';
import { Pm25ConcentrationMeasurement } from '@matter/main/clusters/pm25-concentration-measurement';
import { IlluminanceMeasurement } from '@matter/main/clusters/illuminance-measurement';
import { OccupancySensing } from '@matter/main/clusters/occupancy-sensing';
import { BooleanState } from '@matter/main/clusters/boolean-state';
import { SmokeCoAlarm } from '@matter/main/clusters/smoke-co-alarm';
import { ElectricalPowerMeasurement } from '@matter/main/clusters/electrical-power-measurement';
import profiles from '../fixtures/homey-app/profiles.json' with { type: 'json' };
import { createBridge } from './support/bridge.mjs';
import { eventually } from './support/eventually.mjs';

const reports = [
  ['light-onoff', 'onoff', true, OnOff, 'onOff', true],
  ['light', 'dim', 1, LevelControl, 'currentLevel', 254],
  ['light-color', 'light_hue', 0.5, ColorControl, 'currentHue', 127],
  ['light-extended', 'light_saturation', 1, ColorControl, 'currentSaturation', 254],
  ['socket', 'onoff', true, OnOff, 'onOff', true],
  ['switch-other', 'onoff', true, OnOff, 'onOff', true],
  ['thermostat', 'measure_temperature', 21.5, Thermostat, 'localTemperature', 2150],
  ['heater', 'target_temperature', 22, Thermostat, 'occupiedHeatingSetpoint', 2200],
  ['heatpump', 'target_temperature', 23, Thermostat, 'occupiedHeatingSetpoint', 2300],
  ['airconditioning', 'measure_humidity', 55, RelativeHumidityMeasurement, 'measuredValue', 5500],
  ['lock', 'locked', true, DoorLock, 'lockState', DoorLock.LockState.Locked],
  ['cover-position', 'windowcoverings_set', 0.75, WindowCovering, 'currentPositionLiftPercent100ths', 2500],
  ['cover-state', 'windowcoverings_state', 'up', WindowCovering, 'operationalStatus', WindowCovering.MovementStatus.Opening, (value) => { return value?.lift; }],
  ['measure-temperature', 'measure_temperature', 21.5, TemperatureMeasurement, 'measuredValue', 2150],
  ['measure-humidity', 'measure_humidity', 55, RelativeHumidityMeasurement, 'measuredValue', 5500],
  ['measure-co', 'measure_co', 5, CarbonMonoxideConcentrationMeasurement, 'measuredValue', 5],
  ['measure-co2', 'measure_co2', 420, CarbonDioxideConcentrationMeasurement, 'measuredValue', 420],
  ['measure-pm10', 'measure_pm10', 30, Pm10ConcentrationMeasurement, 'measuredValue', 30],
  ['measure-pm25', 'measure_pm25', 20, Pm25ConcentrationMeasurement, 'measuredValue', 20],
  ['measure-luminance', 'measure_luminance', 1000, IlluminanceMeasurement, 'measuredValue', 30001],
  ['alarm-motion', 'alarm_motion', true, OccupancySensing, 'occupancy', true, (value) => { return value?.occupied; }],
  ['alarm-occupancy', 'alarm_occupancy', true, OccupancySensing, 'occupancy', true, (value) => { return value?.occupied; }],
  ['alarm-contact', 'alarm_contact', true, BooleanState, 'stateValue', false],
  ['alarm-smoke', 'alarm_smoke', true, SmokeCoAlarm, 'smokeState', SmokeCoAlarm.AlarmState.Critical],
  ['socket-power', 'measure_power', 20, ElectricalPowerMeasurement, 'activePower', 20000],
];

test('driver reports reach Matter across the device catalogue', { timeout: 120000 }, async (t) => {
  const { homey, matter, byType } = await createBridge(t, { types: Object.keys(profiles) });

  for (const [type, capability, value, cluster, attribute, expected, project] of reports) {
    await t.test(`${type}: ${capability}`, async () => {
      await matter.expectUpdate(homey, byType[type], capability, value, cluster.Cluster, attribute, expected, { report: true, project });
    });
  }

  await t.test('Matter commands reach the driver and propagate rejection', async () => {
    const light = byType.light;
    await homey.set(light.id, 'onoff', true);
    const path = await matter.path(light, OnOff.Cluster, 'onOff');
    await eventually('Light must be on before the rejection check', async () => {
      return await matter.value(path);
    }, true);
    await homey.control(light, { operation: 'clear-commands' });
    await homey.reject(light, 'onoff', true);
    await assert.rejects(matter.command(light, OnOff.Cluster, 'off'), (error) => {
      return error instanceof StatusResponseError && error.code === Status.Failure;
    });
    assert.equal(await homey.value(light.id, 'onoff'), true);
    assert.equal(await matter.value(path), true);
    assert.deepEqual((await homey.fixture(light)).commands.at(-1), { capability: 'onoff', value: false, accepted: false });
    await homey.reject(light, 'onoff', false);
    await matter.command(light, OnOff.Cluster, 'off');
    await eventually('Accepted Matter command must update Homey', async () => {
      return await homey.value(light.id, 'onoff');
    }, false);
    assert.deepEqual((await homey.fixture(light)).commands.at(-1), { capability: 'onoff', value: false, accepted: true });
  });
});
