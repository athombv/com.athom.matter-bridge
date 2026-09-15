// Implemented official homey-lib capability bases. A suffix identifies an instance,
// never an app-specific behavior. Keep this list limited to mappings we can execute.
export class CapabilityGroups {
  static #bases = new Set([
    'onoff', 'dim', 'light_hue', 'light_saturation', 'light_temperature', 'light_mode',
    'fan_speed', 'target_temperature', 'thermostat_mode', 'locked',
    'windowcoverings_set', 'windowcoverings_state', 'measure_temperature', 'measure_humidity',
    'measure_co', 'measure_co2', 'measure_pm1', 'measure_pm10', 'measure_pm25',
    'measure_luminance', 'alarm_motion', 'alarm_occupancy', 'alarm_contact', 'alarm_smoke',
    'alarm_water', 'measure_power', 'measure_voltage', 'measure_current',
    'meter_power', 'measure_battery', 'alarm_battery',
  ]);

  static forDevice(source) {
    const groups = new Map([['', {}]]);

    for (const id of Object.keys(source.capabilitiesObj ?? {})) {
      const separator = id.indexOf('.');
      const base = separator < 0 ? id : id.slice(0, separator);
      let suffix = separator < 0 ? '' : id.slice(separator + 1);
      let key = base;

      if (!CapabilityGroups.#bases.has(base) || (separator >= 0 && !suffix)) {
        continue;
      }

      // Preserve established mappings and their endpoint identities. Other energy suffixes
      // do not define import/export direction, reset periods, or non-overlapping totals.
      if (base === 'meter_power' && suffix) {
        if (suffix !== 'imported' && suffix !== 'exported') {
          continue;
        }
        key = id;
        suffix = '';
      }
      if (id === 'target_temperature.cool' && source.capabilitiesObj.thermostat_mode) {
        key = id;
        suffix = '';
      }

      const capability = source.capabilitiesObj[id];
      const expectedUnits = {
        measure_pm1: 'µg/m³', measure_voltage: 'V', measure_current: 'A',
      }[base];

      if (expectedUnits) {
        const units = capability.units?.replaceAll('μ', 'µ');
        const wrongUnits = units !== undefined && units !== expectedUnits;
        const wrongType = capability.type !== undefined && capability.type !== 'number';

        if (wrongUnits || wrongType || capability.getable === false) {
          continue;
        }
      }

      const capabilities = groups.get(suffix) ?? {};
      capabilities[key] = id;
      groups.set(suffix, capabilities);
    }

    const result = [];

    for (const suffix of [...groups.keys()].sort()) {
      const ids = groups.get(suffix);
      if (Object.keys(ids).length === 0 && groups.size > 1) {
        continue;
      }

      const capabilitiesObj = {};

      for (const [base, id] of Object.entries(ids)) {
        // Homey API can replace capabilitiesObj while these subscriptions stay active.
        Object.defineProperty(capabilitiesObj, base, {
          enumerable: true,
          get() {
            return source.capabilitiesObj[id];
          },
        });
      }

      const originalClass = source.virtualClass || source.class;
      let deviceClass = originalClass;

      // A measurement-only channel must not advertise the source device's controls.
      if (suffix) {
        const primary = {
          light: ['onoff', 'dim', 'light_hue', 'light_saturation', 'light_temperature'],
          socket: ['onoff'],
          fan: ['onoff', 'fan_speed'],
          thermostat: ['target_temperature', 'thermostat_mode'],
          heatpump: ['target_temperature', 'thermostat_mode'],
          heater: ['target_temperature', 'thermostat_mode'],
          airconditioning: ['target_temperature', 'thermostat_mode'],
          lock: ['locked'],
          windowcoverings: ['windowcoverings_set', 'windowcoverings_state'],
          blinds: ['windowcoverings_set', 'windowcoverings_state'],
          shutterblinds: ['windowcoverings_set', 'windowcoverings_state'],
          curtain: ['windowcoverings_set', 'windowcoverings_state'],
        }[originalClass];
        const hasControl = primary?.some((id) => {
          return capabilitiesObj[id] !== undefined;
        });

        if (primary && !hasControl) {
          deviceClass = 'sensor';
        }
      }

      result.push({
        suffix,
        ids,
        device: {
          id: source.id,
          class: deviceClass,
          capabilitiesObj,
          async setCapabilityValue(write) {
            const capabilityId = ids[write.capabilityId];

            if (!capabilityId || source.capabilitiesObj[capabilityId].setable === false) {
              throw new Error(`Capability ${write.capabilityId} cannot be controlled`);
            }

            return await source.setCapabilityValue({ ...write, capabilityId });
          },
        },
      });
    }

    return result;
  }
}
