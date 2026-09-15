import { Endpoint } from '@matter/main';
import { FanDevice } from '@matter/main/devices/fan';
import { FanControl } from '@matter/main/clusters/fan-control';
import { FanControlServer } from '@matter/main/behaviors/fan-control';
import { OnOffServer } from '@matter/main/behaviors/on-off';

export class FanMapping {
  static speedCapability(capabilities) {
    if (capabilities.fan_speed) {
      return { id: 'fan_speed', min: 0, max: 1, step: 0 };
    }

    // Imported numeric fan controls retain their source range. Require an unambiguous speed field;
    // arbitrary number capabilities and oscillation settings must never be used as speed controls.
    const candidates = Object.entries(capabilities).filter(([id, capability]) => {
      const isSpeedField = id.startsWith('number.') && id.endsWith('_fan_speed');
      const isWritableNumber = capability.type === 'number' && capability.setable === true;
      const hasFiniteRange = Number.isFinite(capability.min) && Number.isFinite(capability.max);
      const hasPositiveRange = capability.min >= 0 && capability.max > capability.min;
      const hasPositiveStep = Number.isFinite(capability.step) && capability.step > 0;

      return isSpeedField && isWritableNumber && hasFiniteRange && hasPositiveRange && hasPositiveStep;
    });

    if (candidates.length !== 1 || !capabilities.onoff) {
      return null;
    }

    const [id, capability] = candidates[0];
    return { id, min: capability.min, max: capability.max, step: capability.step };
  }

  static async add({ device, registerEndpoint, makeCapabilityInstance }) {
    const speed = FanMapping.speedCapability(device.capabilitiesObj);

    if (!speed) {
      return false;
    }

    const hasOnOff = !!device.capabilitiesObj.onoff;
    const setPercent = async (percent) => {
      if (typeof percent !== 'number' || percent < 0 || percent > 100) {
        throw new Error('Fan speed must be between 0 and 100 percent.');
      }
      if (device.capabilitiesObj[speed.id].setable !== true) {
        throw new Error('Fan speed is read-only.');
      }
      if (percent === 0 && hasOnOff) {
        await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
        return;
      }
      if (percent === 0 && speed.min > 0) {
        throw new Error('This fan has no off capability.');
      }

      let value = percent * speed.max / 100;

      if (speed.step > 0) {
        value = speed.min + Math.round((value - speed.min) / speed.step) * speed.step;
      }
      value = Math.max(speed.min, Math.min(speed.max, value));
      await device.setCapabilityValue({ capabilityId: speed.id, value });

      if (hasOnOff && device.capabilitiesObj.onoff.value !== true) {
        await device.setCapabilityValue({ capabilityId: 'onoff', value: true });
      }
    };
    const servers = [FanControlServer];

    if (hasOnOff) {
      servers.push(class HomeyFanOnOffServer extends OnOffServer {
        async on() {
          await device.setCapabilityValue({ capabilityId: 'onoff', value: true });
        }

        async off() {
          await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
        }
      });
    }

    const endpoint = new Endpoint(FanDevice.with(...servers), {
      id: 'main',
      fanControl: { fanMode: FanControl.FanMode.Off, fanModeSequence: FanControl.FanModeSequence.OffHigh, percentSetting: 0, percentCurrent: 0 },
      ...(hasOnOff ? { onOff: { onOff: false } } : {}),
    });
    await registerEndpoint(endpoint);

    const update = async () => {
      const value = device.capabilitiesObj[speed.id].value;

      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return;
      }

      const isOn = value > 0 && (!hasOnOff || device.capabilitiesObj.onoff.value === true);
      const percent = isOn ? Math.round(Math.max(0, Math.min(1, value / speed.max)) * 100) : 0;
      await endpoint.set({
        fanControl: { fanMode: isOn ? FanControl.FanMode.High : FanControl.FanMode.Off, percentSetting: percent, percentCurrent: percent },
        ...(hasOnOff ? { onOff: { onOff: device.capabilitiesObj.onoff.value === true } } : {}),
      });
    };
    makeCapabilityInstance(speed.id, update);
    makeCapabilityInstance('onoff', update);
    endpoint.events.fanControl.percentSetting$Changing.on(async (value, oldValue, context) => {
      if (!context.offline) {
        await setPercent(value);
      }
    });
    endpoint.events.fanControl.fanMode$Changing.on(async (value, oldValue, context) => {
      if (context.offline) {
        return;
      }
      if (value !== FanControl.FanMode.Off && value !== FanControl.FanMode.High && value !== FanControl.FanMode.On) {
        throw new Error('This fan supports off and high modes. Use percentage for intermediate speeds.');
      }
      await setPercent(value === FanControl.FanMode.Off ? 0 : 100);
    });

    return true;
  }
}
