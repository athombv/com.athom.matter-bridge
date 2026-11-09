import { FIXTURE_APP_ID } from './config.mjs';
import profiles from '../../tests/fixtures/homey-app/profiles.json' with { type: 'json' };
import { HomeyClient } from '../../tests/integration/support/HomeyClient.mjs';

const [command, ...args] = process.argv.slice(2);
const homey = new HomeyClient();
await homey.connect();

switch (command) {
  case 'install':
    await homey.install('/output/fixtures.tar.gz', { appId: FIXTURE_APP_ID, readyProperty: 'ready' });
    console.log('Installed fixture app is ready');
    for (const type of Object.keys(profiles)) {
      await homey.createDevice(type, `Lab ${type}`);
    }
    console.log(`Paired ${Object.keys(profiles).length} fixtures before starting the bridge`);
    await homey.install('/output/app.tar.gz');
    console.log(`Installed app is ready on SHS ${homey.version}`);
    break;
  case 'fixtures':
    for (const device of Object.values(await homey.fixtureDevices())) {
      await homey.share(device.id, true);
    }
    console.log(`Shared ${Object.keys(profiles).length} driver-backed lab devices`);
    break;
  case 'devices': {
    const devices = await homey.request('/manager/devices/device');
    console.log(JSON.stringify(Object.values(devices).map((device) => {
      return { name: device.name, id: device.id, capabilities: device.capabilitiesObj };
    }), null, 2));
    break;
  }
  case 'set':
  case 'report':
  case 'availability':
  case 'reject':
  case 'commands': {
    const [name, capability, json] = args;
    const devices = await homey.request('/manager/devices/device');
    const device = Object.values(devices).find((candidate) => { return candidate.name === name || candidate.id === name; });

    if (!device) {
      throw new Error(`Device not found: ${name}`);
    }

    switch (command) {
      case 'set':
        await homey.set(device.id, capability, JSON.parse(json));
        break;
      case 'report':
        await homey.report(device, { [capability]: JSON.parse(json) });
        break;
      case 'availability':
        await homey.availability(device, JSON.parse(capability));
        break;
      case 'reject':
        await homey.reject(device, capability, JSON.parse(json));
        break;
    }

    console.log(JSON.stringify(await homey.fixture(device), null, 2));
    break;
  }
  default:
    throw new Error(`Unknown backend command: ${command}`);
}
