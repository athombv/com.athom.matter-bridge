import { HomeyClient } from '../../tests/integration/support/HomeyClient.mjs';

const [command, ...args] = process.argv.slice(2);
const homey = new HomeyClient();
await homey.connect();

switch (command) {
  case 'install':
    await homey.install('/output/app.tar.gz');
    console.log(`Installed app is ready on SHS ${homey.version}`);
    break;
  case 'fixtures':
    for (const type of ['light', 'socket']) {
      const device = await homey.createDevice(type, `Lab ${type}`);
      await homey.share(device.id, true);
    }
    console.log('Created and shared Lab light and Lab socket');
    break;
  case 'devices': {
    const devices = await homey.request('/manager/devices/device');
    console.log(JSON.stringify(Object.values(devices).map((device) => {
      return { name: device.name, id: device.id, capabilities: device.capabilitiesObj };
    }), null, 2));
    break;
  }
  case 'set': {
    const [name, capability, json] = args;
    const devices = await homey.request('/manager/devices/device');
    const device = Object.values(devices).find((candidate) => { return candidate.name === name || candidate.id === name; });

    if (!device) {
      throw new Error(`Device not found: ${name}`);
    }

    await homey.set(device.id, capability, JSON.parse(json));
    console.log(`${device.name}/${capability} = ${await homey.value(device.id, capability)}`);
    break;
  }
  default:
    throw new Error(`Unknown backend command: ${command}`);
}
