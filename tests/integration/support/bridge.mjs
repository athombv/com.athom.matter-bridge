import { HomeyClient } from './HomeyClient.mjs';
import { MatterController } from './MatterController.mjs';
import { eventually } from './eventually.mjs';

export async function createBridge(t, { types = ['light', 'socket'], commission = true } = {}) {
  const homey = new HomeyClient();
  const matter = new MatterController();
  const devices = [];
  const byType = {};
  t.after(async () => {
    try {
      await matter.close();
    } finally {
      const results = await Promise.allSettled(devices.map((device) => {
        return homey.removeDevice(device.id);
      }));
      const errors = results.filter((result) => { return result.status === 'rejected'; });

      if (errors.length) {
        throw new AggregateError(errors.map((result) => { return result.reason; }), 'Device fixture cleanup failed');
      }
    }
  });

  await homey.connect();
  const fixtures = await homey.fixtureDevices();

  for (const type of types) {
    const device = fixtures[type];

    if (!device) {
      throw new Error(`Missing prepared fixture: ${type}`);
    }
    devices.push(device);
    byType[type] = device;

    if (commission) {
      await homey.share(device.id, true);
    }
  }

  if (!commission) {
    return { homey, devices, byType };
  }

  await matter.connect(homey);

  for (const device of devices) {
    await eventually(`${device.name} must be exposed by the installed app`, async () => {
      return (await matter.endpoint(device.name)) !== undefined;
    }, true);
  }

  t.diagnostic(`SHS ${homey.version}; installed fixture drivers; ${devices.length} devices; Matter UDP subscription`);
  return { homey, matter, devices, byType, light: byType.light, socket: byType.socket };
}
