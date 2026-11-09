import { HomeyClient } from './HomeyClient.mjs';
import { MatterController } from './MatterController.mjs';
import { eventually } from './eventually.mjs';

export async function createBridge(t) {
  const homey = new HomeyClient();
  const matter = new MatterController();
  const devices = [];
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
  const light = await homey.createDevice('light', 'Integration light');
  devices.push(light);
  const socket = await homey.createDevice('socket', 'Integration socket');
  devices.push(socket);
  await homey.share(light.id, true);
  await homey.share(socket.id, true);
  await matter.connect(homey);

  for (const device of devices) {
    await eventually(`${device.name} must be exposed by the installed app`, async () => {
      return (await matter.endpoint(device.name)) !== undefined;
    }, true);
  }

  t.diagnostic(`SHS ${homey.version}; installed app; native virtual light and socket; Matter UDP subscription`);
  return { homey, matter, light, socket };
}
