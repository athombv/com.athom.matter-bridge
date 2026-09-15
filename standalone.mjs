import readline from 'node:readline';

import { HomeyAPI } from 'homey-api';
import { checkbox } from '@inquirer/prompts';

import { MatterBridgeServer } from './lib/MatterBridgeServer.mjs';

console.log('----------------------------------------------');
console.log('Starting Matter Bridge in standalone mode...');
console.log('Press [D] to select Homey devices to expose to Matter.');
console.log('Press [R] to restart the server.');
console.log('Press [Q] to exit.');
console.log('----------------------------------------------');
console.log('');

const api = await HomeyAPI.createLocalAPI({
  address: process.env.HOMEY_ADDRESS,
  token: process.env.HOMEY_TOKEN,
  // debug: (...props) => console.log(`[HomeyAPI]`, ...props),
});

const server = new MatterBridgeServer({
  api,
  debug: (...props) => console.log(`[MatterBridgeServer]`, ...props),
  storageServiceLocation: './.matter/',
  deviceName: 'Homey Matter Bridge',
  vendorName: 'Athom B.V.',
  vendorId: 65521,
  productName: 'Homey Matter Bridge',
  productId: 32768,
  uniqueId: 'standalone',
  serialNumber: 'standalone',
  passcode: 20202021,
  discriminator: 3840,
  port: 5540,
  enabledDeviceIds: new Set(process.env.HOMEY_DEVICE_IDS?.split(',').map(id => id.trim()).filter(id => id) || []),
});
await server.start();

// Graceful Shutdown
process.once('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  api.destroy();
  process.stdin.setRawMode(false);
});

process.once('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  api.destroy();
  process.stdin.setRawMode(false);
});

// Listen for Key Presses in the CLI
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.on('keypress', (chunk, key) => {
  switch (key?.name) {
    case 'q': {
      console.log('Exiting...');
      process.exit();
      break;
    }

    case 'r': {
      console.log('Restarting...');
      process.exit(42); // Special code to indicate restart
      break;
    }

    case 'd': {
      Promise.resolve().then(async () => {
        const devices = await api.devices.getDevices();
        const selectedDeviceIds = await checkbox({
          message: 'Which Homey devices should be exposed to Matter?',
          choices: Object.values(devices).map(device => ({
            name: `${device.id} — ${device.name}`,
            value: device.id,
            checked: server.enabledDeviceIds.has(device.id),
          })),
          loop: false,
        }).catch(() => []);

        // Uninitialize old devices
        for (const deviceId of server.enabledDeviceIds.values()) {
          if (!selectedDeviceIds.includes(deviceId)) {
            await server.disableDevice(deviceId);
          }
        }

        // Initialize new devices
        for (const deviceId of selectedDeviceIds) {
          if (!server.enabledDeviceIds.has(deviceId)) {
            await server.enableDevice(deviceId);
          }
        }

        // Resume Listening for Key Presses
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }
        process.stdin.resume();
      }).catch(err => console.error(err));
      break;
    }
  }
});