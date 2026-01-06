import crypto from 'node:crypto';

import Homey from 'homey';
import { HomeyAPI } from 'homey-api';
import MatterBridgeServer from './MatterBridgeServer.mjs'

export default class MatterBridgeApp extends Homey.App {

  async onInit() {
    this.log('Starting Matter Bridge Server...');

    this.homey.on('cpuwarn', ({ count, limit }) => {
      this.log(`CPU Warning: ${count}/${limit}`);

      if (this.server) {
        if (this.__resumeQueueTimeout) return;

        this.log('Pausing Queues...');
        this.server.pauseQueue();

        this.__resumeQueueTimeout = setTimeout(() => {
          this.log('Resuming Queues...');
          clearTimeout(this.__resumeQueueTimeout);
          this.server.resumeQueue();
        }, 11000); // 11s
      }
    });

    this.api = await HomeyAPI.createAppAPI({
      homey: this.homey,
      // debug: (...props) => this.log(`[HomeyAPI]`, ...props),
    });

    await this.api.zones.connect();
    await this.api.zones.getZones();

    await this.api.drivers.connect();
    await this.api.drivers.getDrivers();

    await this.api.devices.connect();
    await this.api.devices.getDevices();

    this.server = new MatterBridgeServer({
      api: this.api,
      debug: (...props) => this.log(`[MatterBridgeServer]`, ...props),
      deviceName: await this.getSetting('deviceName', 'Homey Matter Bridge'),
      vendorName: await this.getSetting('vendorName', 'Athom B.V.'),
      vendorId: await this.getSetting('vendorId', 65521),
      productName: await this.getSetting('productName', 'Homey Matter Bridge'),
      productId: await this.getSetting('productId', 32768),
      uniqueId: await this.getSetting('uniqueId', crypto.randomUUID()),
      serialNumber: await this.getSetting('serialNumber', crypto.randomUUID()),
      passcode: await this.getSetting('passcode', 20202021),
      discriminator: await this.getSetting('discriminator', 3840),
      port: await this.getSetting('port', 5540),
      enabledDeviceIds: await this.getEnabledDeviceIds(),
      storageServiceLocation: '/userdata',
    });
    await this.server.start();

    // If this is the first time, create a Timeline notification to guide the user to the settings page.
    const timelineNotificationWelcomeCreated = !(await this.homey.settings.get('timelineNotificationWelcomeCreated'));
    if (timelineNotificationWelcomeCreated) {
      await this.homey.notifications.createNotification({
        excerpt: 'Welcome to Matter Bridge! Visit the app\'s settings to get started.',
      });
      await this.homey.settings.set('timelineNotificationWelcomeCreated', true);
    }
  }

  // We save the default setting value, because if we need to change it later,
  // existing installations will keep using the value specified back then.
  async getSetting(key, defaultValue = null) {
    const value = await this.homey.settings.get(key);
    if (value === null || value === undefined) {
      await this.homey.settings.set(key, defaultValue);
      return defaultValue;
    }
    return value;
  }

  async getEnabledDeviceIds() {
    return new Set(await this.homey.settings.get('enabledDeviceIds') || []);
  }

  async onAPIGetState() {
    if (!this.server) {
      throw new Error('Server Not Ready');
    }

    return this.server.getState();
  }

  async onAPIGetDevices() {
    const enabledDeviceIds = await this.getEnabledDeviceIds();
    const devices = await this.api.devices.getDevices();

    const result = [];
    for (const device of Object.values(devices)) {
      if (device.flags.includes('matter')) continue; // Skip Matter devices
      if (device.driverId === 'homey:virtualdrivergroup:driver') continue; // Skip Grouped Devices

      const deviceObj = {
        id: device.id,
        name: device.name,
        iconUrl: device.iconObj?.url,
        iconOverride: device.iconOverride,
        isSelected: enabledDeviceIds.has(device.id),
      };

      // Add Zone Name
      const zone = await device.getZone();
      deviceObj.zoneName = zone ? zone.name : null;

      result.push(deviceObj);
    }

    return result;
  }

  async onAPIEnableDevice({ deviceId }) {
    const enabledDeviceIds = await this.getEnabledDeviceIds();
    if (!enabledDeviceIds.has(deviceId)) {
      enabledDeviceIds.add(deviceId);
      await this.homey.settings.set('enabledDeviceIds', Array.from(enabledDeviceIds));
      this.server.enableDevice(deviceId).catch(err => {
        this.log(`Error enabling device ${deviceId}:`, err);
      });
    }
  }

  async onAPIDisableDevice({ deviceId }) {
    const enabledDeviceIds = await this.getEnabledDeviceIds();
    if (enabledDeviceIds.has(deviceId)) {
      enabledDeviceIds.delete(deviceId);
      await this.homey.settings.set('enabledDeviceIds', Array.from(enabledDeviceIds));
      this.server.disableDevice(deviceId).catch(err => {
        this.log(`Error disabling device ${deviceId}:`, err);
      });
    }
  }

}
