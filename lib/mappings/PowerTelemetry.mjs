import { Endpoint } from '@matter/main';
import { ElectricalSensorEndpoint } from '@matter/main/endpoints/electrical-sensor';
import { PowerSourceEndpoint } from '@matter/main/endpoints/power-source';
import { PowerTopologyServer } from '@matter/main/behaviors/power-topology';
import { ElectricalPowerMeasurementServer } from '@matter/main/behaviors/electrical-power-measurement';
import { ElectricalEnergyMeasurementServer } from '@matter/main/behaviors/electrical-energy-measurement';
import { PowerSource } from '@matter/main/clusters/power-source';
import { ElectricalPowerMeasurement } from '@matter/main/clusters/electrical-power-measurement';
import { PowerSourceServer } from '@matter/main/behaviors/power-source';
import { MeasurementType } from '@matter/main/types';

export class PowerTelemetry {
  static importedCapability(capabilities) {
    return capabilities.meter_power ? 'meter_power' : 'meter_power.imported';
  }

  static accuracy(measurementType) {
    return {
      measurementType,
      measured: true,
      minMeasuredValue: Number.MIN_SAFE_INTEGER,
      maxMeasuredValue: Number.MAX_SAFE_INTEGER,
      accuracyRanges: [{
        rangeMin: Number.MIN_SAFE_INTEGER,
        rangeMax: Number.MAX_SAFE_INTEGER,
        fixedMax: 1,
      }],
    };
  }

  static energy(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    const energy = Math.round(value * 1000000); // Homey kWh to Matter mWh.

    if (!Number.isSafeInteger(energy)) {
      return null;
    }

    return { energy };
  }

  static async add({ device, parent, registerEndpoint, makeCapabilityInstance, subscriptions, endpointId }) {
    const capabilities = device.capabilitiesObj;
    const importedId = PowerTelemetry.importedCapability(capabilities);
    const imported = capabilities[importedId];
    const exported = capabilities['meter_power.exported'];
    const measurements = [
      ['measure_power', 'activePower', MeasurementType.ActivePower],
      ['measure_voltage', 'voltage', MeasurementType.Voltage],
      ['measure_current', 'activeCurrent', MeasurementType.ActiveCurrent],
    ].filter(([id]) => {
      return capabilities[id] && !subscriptions?.[id];
    });

    if (imported || exported || measurements.length) {
      const servers = [PowerTopologyServer.with('TreeTopology')];
      const properties = { id: endpointId('energy') };

      if (measurements.length) {
        servers.push(ElectricalPowerMeasurementServer);
        properties.electricalPowerMeasurement = {
          powerMode: ElectricalPowerMeasurement.PowerMode.Unknown,
          numberOfMeasurementTypes: measurements.length,
          activePower: null, // Mandatory even when only voltage/current is measured.
          accuracy: measurements.map(([, , type]) => {
            return PowerTelemetry.accuracy(type);
          }),
          ...Object.fromEntries(measurements.map(([, attribute]) => {
            return [attribute, null];
          })),
        };
      }

      if (imported || exported) {
        const features = ['CumulativeEnergy'];

        if (imported) {
          features.push('ImportedEnergy');
        }
        if (exported) {
          features.push('ExportedEnergy');
        }
        servers.push(ElectricalEnergyMeasurementServer.with(...features));
        properties.electricalEnergyMeasurement = {
          accuracy: PowerTelemetry.accuracy(MeasurementType.ElectricalEnergy),
          ...(imported ? { cumulativeEnergyImported: null } : {}),
          ...(exported ? { cumulativeEnergyExported: null } : {}),
        };
      }

      const endpoint = new Endpoint(ElectricalSensorEndpoint.with(...servers), properties);
      await registerEndpoint(endpoint);

      for (const [id, attribute] of measurements) {
        makeCapabilityInstance(id, async (value) => {
          // W, V and A are represented as milli-units on the Matter boundary.
          const scaled = typeof value === 'number' ? Math.round(value * 1000) : NaN;
          const reading = Number.isSafeInteger(scaled) ? scaled : null;
          await endpoint.set({ electricalPowerMeasurement: { [attribute]: reading } });
        });
      }

      for (const [capabilityId, direction] of [[importedId, 'imported'], ['meter_power.exported', 'exported']]) {
        if (!capabilities[capabilityId]) {
          continue;
        }
        makeCapabilityInstance(capabilityId, async (value) => {
          await endpoint.act((agent) => {
            agent.get(ElectricalEnergyMeasurementServer).setMeasurement({
              cumulativeEnergy: { [direction]: PowerTelemetry.energy(value) },
            });
          });
        });
      }
    }

    if (!capabilities.measure_battery && !capabilities.alarm_battery) {
      return;
    }

    const endpoint = new Endpoint(PowerSourceEndpoint.with(PowerSourceServer.with('Battery')), {
      id: endpointId('battery'),
      powerSource: {
        status: PowerSource.PowerSourceStatus.Active,
        order: 0,
        description: 'Battery',
        batPresent: true,
        batReplacementNeeded: false,
        batReplaceability: PowerSource.BatReplaceability.Unspecified,
        batChargeLevel: PowerSource.BatChargeLevel.Ok,
        ...(capabilities.measure_battery ? { batPercentRemaining: null } : {}),
        endpointList: [parent.number],
      },
    });
    await registerEndpoint(endpoint);
    makeCapabilityInstance('measure_battery', async (value) => {
      const batPercentRemaining = typeof value === 'number' && Number.isFinite(value)
        ? Math.round(Math.max(0, Math.min(100, value)) * 2)
        : null;
      await endpoint.set({ powerSource: { batPercentRemaining } });
    });
    makeCapabilityInstance('alarm_battery', async (value) => {
      await endpoint.set({ powerSource: {
        batChargeLevel: value ? PowerSource.BatChargeLevel.Warning : PowerSource.BatChargeLevel.Ok,
        batReplacementNeeded: value,
      } });
    });
  }
}
