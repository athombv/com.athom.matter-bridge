import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import PQueue from 'p-queue';
import { Endpoint, Environment, StorageService, ServerNode, VendorId } from '@matter/main';
import { BridgedNodeEndpoint } from '@matter/main/endpoints/bridged-node';
import { BridgeCommissioningServer } from './BridgeCommissioningServer.mjs';

import {
  ElectricalPowerMeasurement,
  AirQuality,
  ConcentrationMeasurement,
  Thermostat,
  ColorControl,
  SmokeCoAlarm,
  OccupancySensing,
  WindowCovering,
  DoorLock,
} from '@matter/main/clusters';
import {
  AggregatorEndpoint,
} from '@matter/main/endpoints';
import {
  OnOffPlugInUnitDevice,
  OnOffLightDevice,
  DimmableLightDevice,
  ColorTemperatureLightDevice,
  ExtendedColorLightDevice,
  TemperatureSensorDevice,
  HumiditySensorDevice,
  ThermostatDevice,
  RoomAirConditionerDevice,
  SmokeCoAlarmDevice,
  AirQualitySensorDevice,
  OccupancySensorDevice,
  ContactSensorDevice,
  WindowCoveringDevice,
  DoorLockDevice,
  LightSensorDevice,
} from '@matter/main/devices';
import {
  OnOffServer,
  LevelControlServer,
  ColorControlServer,
  TemperatureMeasurementServer,
  RelativeHumidityMeasurementServer,
  CarbonMonoxideConcentrationMeasurementServer,
  CarbonDioxideConcentrationMeasurementServer,
  Pm10ConcentrationMeasurementServer,
  Pm25ConcentrationMeasurementServer,
  SmokeCoAlarmServer,
  ElectricalPowerMeasurementServer,
  ThermostatServer,
  BooleanStateServer,
  WindowCoveringServer,
  DoorLockServer,
  OccupancySensingServer,
} from '@matter/main/behaviors';
import {
  MeasurementType,
} from '@matter/main/types';

export default class MatterBridgeServer {

  constructor({
    api,
    debug,
    deviceName = null,
    vendorName = null,
    vendorId = null,
    productName = null,
    productId = null,
    uniqueId = null,
    serialNumber = null,
    passcode = null,
    discriminator = null,
    port = 5540,
    storageServiceLocation = join(homedir(), '.matter-bridge'),
    enabledDeviceIds = new Set(),
    releaseStaleStorageLock = false,
  }) {
    this.api = api;
    this.debug = debug;

    this.__queue = new PQueue({ concurrency: 1 });
    this.pairingQueue = new PQueue({ concurrency: 1 });

    this.deviceName = deviceName;
    this.vendorName = vendorName;
    this.vendorId = vendorId;
    this.productName = productName;
    this.productId = productId;
    this.uniqueId = uniqueId;
    this.serialNumber = serialNumber;
    this.passcode = passcode;
    this.discriminator = discriminator;
    this.port = port;

    this.enabledDeviceIds = enabledDeviceIds;
    this.storageServiceLocation = storageServiceLocation;
    this.releaseStaleStorageLock = releaseStaleStorageLock;

    this.serverNode = null;
    this.aggregatorEndpoint = null;
    this.deviceEndpoints = {
      // [deviceId]: Endpoint
    };
    this.deviceCapabilityInstances = {
      // [deviceId]: {
      //   [capabilityId]: CapabilityInstance
      // }
    };
    this.deviceEndpointInstances = {
      // [deviceId]: Set()
    };

    // Set storage location
    this.environment = Environment.default;

    this.environment.vars.set('storage.path', storageServiceLocation);
    this.storageService = this.environment.get(StorageService);
  }

  async getState() {
    let pairing = null;
    if (this.serverNode?.lifecycle.isOnline) {
      pairing = await this.serverNode.act((agent) => {
        return agent.get(BridgeCommissioningServer).getLocalPairing();
      });
    }
    const commissioned = this.serverNode?.lifecycle?.isCommissioned ?? null;
    return {
      commissioned,
      qrPairingCode: commissioned ? null : this.serverNode?.state?.commissioning?.pairingCodes?.qrPairingCode ?? null,
      manualPairingCode: commissioned ? null : this.serverNode?.state?.commissioning?.pairingCodes?.manualPairingCode ?? null,
      pairing,
    };
  }

  async startPairing() {
    return await this.pairingQueue.add(async () => {
      if (!this.serverNode?.lifecycle.isOnline) throw new Error('Server Not Ready');
      await this.serverNode.act(async (agent) => {
        await agent.get(BridgeCommissioningServer).startLocalPairing();
      });
      return await this.getState();
    });
  }

  async stopPairing() {
    return await this.pairingQueue.add(async () => {
      if (!this.serverNode?.lifecycle.isOnline) throw new Error('Server Not Ready');
      await this.serverNode.act(async (agent) => {
        await agent.get(BridgeCommissioningServer).stopLocalPairing();
      });
      return await this.getState();
    });
  }

  async stop() {
    await this.pairingQueue.onIdle();
    if (this.serverNode) await this.serverNode.close();
    this.serverNode = null;
  }

  async start() {
    if (this.serverNode) {
      throw new Error('Already Started Server');
    }

    if (this.releaseStaleStorageLock) {
      await this.__releaseStaleStorageLock();
    }

    // Create the Server
    this.serverNode = await ServerNode.create(ServerNode.RootEndpoint.with(BridgeCommissioningServer), {
      id: this.uniqueId,
      network: {
        port: this.port,
      },
      commissioning: {
        passcode: this.passcode,
        discriminator: this.discriminator,
      },
      productDescription: {
        name: this.deviceName,
        deviceType: AggregatorEndpoint.deviceType,
      },
      basicInformation: {
        vendorName: ellipseString(this.vendorName),
        vendorId: VendorId(this.vendorId),
        nodeLabel: ellipseString(this.productName),
        productName: ellipseString(this.productName),
        productLabel: ellipseString(this.productName),
        productId: this.productId,
        serialNumber: ellipseString(this.serialNumber),
        uniqueId: ellipseString(this.uniqueId),
      },
    });

    // Create an Aggregator Endpoint and start the Server
    this.aggregatorEndpoint = new Endpoint(AggregatorEndpoint, {
      id: 'aggregator',
    });
    await this.serverNode.add(this.aggregatorEndpoint);

    // Get all Homey Drivers
    await this.api.drivers.connect();
    await this.api.drivers.getDrivers();

    // Get all Homey Devices
    await this.api.devices.connect();
    await this.api.devices.getDevices();
    const devices = await this.api.devices.getDevices();

    // Initialize all Devices
    for (const device of Object.values(devices)) {
      if (!this.enabledDeviceIds.has(device.id)) continue;
      await this.__initEndpoint(device).catch(err => this.debug(`Error initializing endpoint for device ${device.id} during startup: ${err.message}`));

      if (device.ready === true) {
        await this.__initDevice(device).catch(err => this.debug(`Error initializing device ${device.id} during startup: ${err.message}`));
      }
    }

    // Subscribe to Device events
    this.api.devices.on('device.delete', device => {
      if (!this.enabledDeviceIds.has(device.id)) return;
      if (!this.deviceEndpoints[device.id]) return;

      Promise.resolve().then(async () => {
        await this.__uninitEndpoint(device);
      }).catch(err => this.debug(`Error uninitializing device ${device.id} on delete: ${err.message}`));
    })
    this.api.devices.on('device.update', (device) => {
      if (!this.enabledDeviceIds.has(device.id)) return;

      if (device.ready === true && !this.deviceEndpointInstances[device.id]) {
        this.debug(`Device ${device.name} (${device.id}) became ready`);
        this.__initDevice(device).catch((err) => {
          this.debug(`Error initializing device ${device.id} on ready:`, err);
        });
      }
    });

    // Finally, start the server
    await this.serverNode.start();
    this.debug('Matter Bridge Server has started.');
  }

  // matter.js locks the node's storage directory with matter.lock/matter.pid and
  // removes them on a clean exit. When the process is killed (e.g. Homey reboots
  // for a firmware update), they stay behind. matter.js only reclaims the lock when
  // `process.kill(pid, 0)` reports ESRCH; inside Homey's app container the old PID
  // can belong to another process or the check fails with EPERM, so every start
  // throws "Storage is locked by another process" and the app crash-loops.
  // Homey runs a single instance of this app, so a lock found before the server
  // has started is always stale.
  async __releaseStaleStorageLock() {
    const directory = join(this.storageServiceLocation, this.uniqueId);
    for (const file of ['matter.lock', 'matter.pid']) {
      await rm(join(directory, file), { force: true });
    }
  }

  async enableDevice(deviceId) {
    if (this.enabledDeviceIds.has(deviceId)) return;

    // Capability subscriptions are detached while unshared, so cached values may be stale.
    const device = await this.api.devices.getDevice({ id: deviceId, $cache: false });
    if (!device) {
      throw new Error(`Device with ID ${deviceId} not found`);
    }

    this.enabledDeviceIds.add(deviceId);
    await this.__initEndpoint(device);

    if (device.ready === true) {
      await this.__initDevice(device);
    }
  }

  async disableDevice(deviceId) {
    if (!this.enabledDeviceIds.has(deviceId)) return;

    const device = await this.api.devices.getDevice({ id: deviceId });
    if (!device) {
      throw new Error(`Device with ID ${deviceId} not found`);
    }

    this.enabledDeviceIds.delete(deviceId);
    await this.__uninitEndpoint(device).catch(err => this.debug(`Error uninitializing endpoint for device ${device.id} on disable: ${err.message}`));
  }

  async __initEndpoint(device) {
    return this.__queue.add(async () => {
      this.debug(`Initializing Endpoint for ${device.name} (${device.id})`);

      // Get the device's driver
      const driver = await device.getDriver();

      // Create a Matter Endpoint
      this.deviceEndpoints[device.id] = new Endpoint(BridgedNodeEndpoint, {
        id: device.id,
        bridgedDeviceBasicInformation: {
          nodeLabel: ellipseString(device.name),
          vendorName: ellipseString(driver?.ownerName ?? 'Unknown'),
          productName: ellipseString(driver?.name ?? 'Unknown'),
          serialNumber: ellipseString(device.id.replaceAll('-', '')), // Max length is 32, so if we remove the dashes from the UUIDv4, it fits!
        },
      });
      await this.aggregatorEndpoint.add(this.deviceEndpoints[device.id]);
      await MatterBridgeServer.applyCreationState(this.deviceEndpoints[device.id])
        .catch((err) => { this.debug(`Error applying the current state of device ${device.id}: ${err.message}`); });
    });
  }

  async __initDevice(device) {
    return this.__queue.add(async () => {
      this.debug(`Initializing Device for ${device.name} (${device.id})`);

      const deviceEndpoint = this.deviceEndpoints[device.id];
      if (!deviceEndpoint) {
        throw new Error(`Device Endpoint for device ${device.id} not found during initialization`);
      }

      // Check if this device is already initialized
      if (this.deviceEndpointInstances[device.id]) {
        this.debug(`Device ${device.name} (${device.id}) is already initialized`);
        return;
      }

      // Helper to create a Capability Instance, and store a reference to destroy it on uninitialization.
      const makeCapabilityInstance = (capabilityId, callback) => {
        if (!device.capabilitiesObj?.[capabilityId]) return;

        this.deviceCapabilityInstances[device.id] = this.deviceCapabilityInstances[device.id] || {};
        if (this.deviceCapabilityInstances[device.id][capabilityId]) return;

        this.deviceCapabilityInstances[device.id][capabilityId] = device.makeCapabilityInstance(capabilityId, (...props) => {
          Promise.resolve().then(async () => {
            await callback(...props);
          }).catch(err => this.debug(`Error in capability instance callback for device ${device.id} capability ${capabilityId}: ${err.message}`));
        });
      }

      const registerEndpoint = async endpoint => {
        this.deviceEndpointInstances[device.id] = this.deviceEndpointInstances[device.id] || new Set();
        this.deviceEndpointInstances[device.id].add(endpoint);

        await deviceEndpoint.add(endpoint);
        await MatterBridgeServer.applyCreationState(endpoint)
          .catch((err) => { this.debug(`Error applying the current state of device ${device.id} to ${endpoint.id}: ${err.message}`); });
      }

      // Add Matter Behaviors based on the device class and capabilities
      const deviceClass = device.virtualClass || device.class;
      switch (deviceClass) {
        case 'socket': {
          class HomeyOnOffServer extends OnOffServer {
            async on() {
              await device.setCapabilityValue({
                capabilityId: 'onoff',
                value: true,
              })
            }

            async off() {
              await device.setCapabilityValue({
                capabilityId: 'onoff',
                value: false,
              });
            }
          }

          const endpointServers = [];
          const endpointProperties = {
            id: 'main',
          };

          if (device.capabilitiesObj?.onoff) {
            endpointServers.push(HomeyOnOffServer);
            endpointProperties.onOff = {
              onOff: device.capabilitiesObj?.onoff?.value ?? false,
            };

            makeCapabilityInstance('onoff', async value => {
              await endpoint.set({
                onOff: {
                  onOff: value ?? false,
                },
              });
            });
          }

          if (device.capabilitiesObj?.measure_power) {
            const power = device.capabilitiesObj.measure_power.value;

            endpointServers.push(ElectricalPowerMeasurementServer);
            endpointProperties.electricalPowerMeasurement = {
              powerMode: ElectricalPowerMeasurement.PowerMode.Unknown,
              numberOfMeasurementTypes: 1,
              accuracy: [{
                measurementType: MeasurementType.ActivePower, // mW
                measured: true,
                minMeasuredValue: Number.MIN_SAFE_INTEGER,
                maxMeasuredValue: Number.MAX_SAFE_INTEGER,
                accuracyRanges: [
                  {
                    rangeMin: Number.MIN_SAFE_INTEGER,
                    rangeMax: Number.MAX_SAFE_INTEGER,
                    fixedMax: 1,
                  },
                ],
              }],
              activePower: typeof power === 'number' ? Math.round(power * 1000) : null, // W to mW
            };

            makeCapabilityInstance('measure_power', async (value) => {
              await endpoint.set({
                electricalPowerMeasurement: {
                  activePower: typeof value === 'number' ? Math.round(value * 1000) : null, // W to mW
                },
              });
            });
          }

          const endpoint = new Endpoint(OnOffPlugInUnitDevice.with(...endpointServers), endpointProperties);
          await registerEndpoint(endpoint);

          break;
        }

        case 'light': {
          class HomeyOnOffServer extends OnOffServer {
            async on() {
              await device.setCapabilityValue({
                capabilityId: 'onoff',
                value: true,
              })
            }

            async off() {
              await device.setCapabilityValue({
                capabilityId: 'onoff',
                value: false,
              });
            }
          }

          class HomeyLevelControlServer extends LevelControlServer {
            async moveToLevelWithOnOff({
              level,
            }) {
              await Promise.all([
                device.capabilitiesObj.onoff && device.setCapabilityValue({
                  capabilityId: 'onoff',
                  value: level > 0,
                }),
                device.capabilitiesObj.dim && device.setCapabilityValue({
                  capabilityId: 'dim',
                  value: scaleNumber(level, 1, 254, 0, 1),
                }),
              ]);
            }

            async moveToLevel({
              level,
            }) {
              await device.setCapabilityValue({
                capabilityId: 'dim',
                value: scaleNumber(level, 1, 254, 0, 1),
              });
            }
          }

          class HomeyColorControlServer extends ColorControlServer {

            async initialize() {
              // A color temperature stored with the earlier range (1–300 mireds) is restored over the Endpoint's
              // properties, and would fail validation against the current range, so keep it within the range.
              if (typeof this.state.colorTemperatureMireds === 'number') {
                this.state.colorTemperatureMireds = Math.min(Math.max(
                  this.state.colorTemperatureMireds,
                  COLOR_TEMPERATURE_MIN_MIREDS,
                ), COLOR_TEMPERATURE_MAX_MIREDS);
              }
              await super.initialize();
            }

            async moveToHueAndSaturation({
              hue,
              saturation,
            }) {
              await Promise.all([
                device.capabilitiesObj.onoff && device.setCapabilityValue({
                  capabilityId: 'onoff',
                  value: true,
                }),
                device.capabilitiesObj.light_hue && device.setCapabilityValue({
                  capabilityId: 'light_hue',
                  value: scaleNumber(hue, 0, 254, 0, 1),
                }),
                device.capabilitiesObj.light_saturation && device.setCapabilityValue({
                  capabilityId: 'light_saturation',
                  value: scaleNumber(saturation, 1, 254, 0, 1),
                }),
                device.capabilitiesObj.light_mode && device.setCapabilityValue({
                  capabilityId: 'light_mode',
                  value: 'color',
                }),
              ]);
            }

            async moveToColorTemperature({
              colorTemperatureMireds,
            }) {
              await Promise.all([
                device.capabilitiesObj.onoff && device.setCapabilityValue({
                  capabilityId: 'onoff',
                  value: true,
                }),
                device.capabilitiesObj.light_temperature && device.setCapabilityValue({
                  capabilityId: 'light_temperature',
                  value: miredsToLightTemperature(colorTemperatureMireds),
                }),
                device.capabilitiesObj.light_mode && device.setCapabilityValue({
                  capabilityId: 'light_mode',
                  value: 'temperature',
                }),
              ]);
            }

          }

          let endpointClass = OnOffLightDevice;
          const endpointServers = [];
          const endpointProperties = {
            id: 'main',
          };

          if (device?.capabilitiesObj?.onoff) {
            endpointServers.push(HomeyOnOffServer);
            endpointProperties.onOff = {
              onOff: device.capabilitiesObj?.onoff?.value ?? false,
            };

            makeCapabilityInstance('onoff', async value => {
              await endpoint.set({
                onOff: {
                  onOff: value ?? false,
                },
              });
            });
          }

          if (device?.capabilitiesObj?.dim) {
            endpointClass = DimmableLightDevice;
            endpointServers.push(HomeyLevelControlServer);
            endpointProperties.levelControl = {
              currentLevel: scaleNumber(device.capabilitiesObj?.dim?.value, 0, 1, 1, 254) ?? 1,
              minLevel: 1,
              maxLevel: 254,
            };

            makeCapabilityInstance('dim', async value => {
              await endpoint.set({
                levelControl: {
                  currentLevel: scaleNumber(value, 0, 1, 1, 254) ?? 1,
                },
              });
            });
          }

          if (device?.capabilitiesObj?.light_hue && device?.capabilitiesObj?.light_saturation) {
            endpointProperties.colorControl = {
              ...endpointProperties.colorControl,
              colorMode: ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
              currentHue: scaleAndRoundNumber(device.capabilitiesObj?.light_hue?.value, 0, 1, 0, 254) ?? 0,
              currentSaturation: scaleAndRoundNumber(device.capabilitiesObj?.light_saturation?.value, 0, 1, 0, 254) ?? 0,
            };

            makeCapabilityInstance('light_hue', async value => {
              await endpoint.set({
                colorControl: {
                  currentHue: scaleNumber(value, 0, 1, 0, 254) ?? 0,
                },
              });
            });

            makeCapabilityInstance('light_saturation', async value => {
              await endpoint.set({
                colorControl: {
                  currentSaturation: scaleNumber(value, 0, 1, 0, 254) ?? 0,
                },
              });
            });
          }

          if (device?.capabilitiesObj?.light_temperature) {
            endpointProperties.colorControl = {
              ...endpointProperties.colorControl,
              colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
              colorTemperatureMireds: lightTemperatureToMireds(device.capabilitiesObj?.light_temperature?.value),
              colorTempPhysicalMinMireds: COLOR_TEMPERATURE_MIN_MIREDS,
              colorTempPhysicalMaxMireds: COLOR_TEMPERATURE_MAX_MIREDS,
              coupleColorTempToLevelMinMireds: COLOR_TEMPERATURE_MIN_MIREDS,
            };

            makeCapabilityInstance('light_temperature', async value => {
              await endpoint.set({
                colorControl: {
                  colorTemperatureMireds: lightTemperatureToMireds(value),
                },
              });
            });
          }

          if (device.capabilitiesObj?.light_hue && device.capabilitiesObj?.light_saturation && !device.capabilitiesObj?.light_temperature) {
            endpointClass = DimmableLightDevice;
            endpointServers.push(HomeyColorControlServer.with(ColorControl.Feature.HueSaturation)); // Only Color
          } else if (!device.capabilitiesObj?.light_hue && !device.capabilitiesObj?.light_saturation && device.capabilitiesObj?.light_temperature) {
            endpointClass = ColorTemperatureLightDevice;
            endpointServers.push(HomeyColorControlServer.with(ColorControl.Feature.ColorTemperature)); // Only Temperature
          } else if (device.capabilitiesObj?.light_hue && device.capabilitiesObj?.light_saturation && device.capabilitiesObj?.light_temperature) {
            endpointClass = ExtendedColorLightDevice;
            endpointServers.push(HomeyColorControlServer.with(ColorControl.Feature.HueSaturation, ColorControl.Feature.ColorTemperature)); // Both Color & Temperature
          }

          if (device.capabilitiesObj?.light_hue
            && device.capabilitiesObj?.light_saturation
            && device.capabilitiesObj?.light_temperature) {

            switch (device.capabilitiesObj?.light_mode?.value) {
              case null:
              case 'color': {
                endpointProperties.colorControl.colorMode = ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
                delete endpointProperties.colorControl.colorTemperatureMireds;
                break;
              }
              case 'temperature': {
                endpointProperties.colorControl.colorMode = ColorControl.ColorMode.ColorTemperatureMireds;
                delete endpointProperties.colorControl.currentHue;
                delete endpointProperties.colorControl.currentSaturation;
                break;
              }
            }
          }

          if (device.capabilitiesObj?.light_mode) {
            makeCapabilityInstance('light_mode', async value => {
              // TODO: Apple Home does not seem to change the mode when this method is called.
              switch (value) {
                case 'color': {
                  await endpoint.set({
                    colorControl: {
                      colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
                    },
                  });
                  break;
                }
                case 'temperature': {
                  await endpoint.set({
                    colorControl: {
                      colorMode: ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
                    },
                  });
                  break;
                }
              }
            });
          }

          const endpoint = new Endpoint(endpointClass.with(...endpointServers), endpointProperties);
          await registerEndpoint(endpoint);

          break;
        }

        case 'thermostat':
        case 'heatpump':
        case 'heater':
        case 'airconditioning': {
          const thermostatServerFeatures = [];

          let hasOff = true;
          let hasHeat = true;
          let hasCool = false;
          let hasAuto = false;

          if (device.capabilitiesObj?.thermostat_mode) {
            hasHeat = !!device.capabilitiesObj?.thermostat_mode?.values?.find(value => value.id === 'heat');
            hasHeat && thermostatServerFeatures.push(Thermostat.Feature.Heating);

            hasCool = !!device.capabilitiesObj?.thermostat_mode?.values?.find(value => value.id === 'cool');
            hasCool && thermostatServerFeatures.push(Thermostat.Feature.Cooling);

            hasAuto = !!device.capabilitiesObj?.thermostat_mode?.values?.find(value => value.id === 'auto');
            hasAuto && thermostatServerFeatures.push(Thermostat.Feature.AutoMode);

            hasOff = !!device.capabilitiesObj?.thermostat_mode?.values?.find(value => value.id === 'off');
          } else {
            hasHeat && thermostatServerFeatures.push(Thermostat.Feature.Heating);
          }

          // Skip thermostats without any supported modes
          if (!hasHeat && !hasCool && !hasAuto && !hasOff) return;

          const EndpointClass = (() => {
            switch (deviceClass) {
              case 'airconditioning': return RoomAirConditionerDevice;
              default: return ThermostatDevice;
            }
          })();

          const endpoint = new Endpoint(EndpointClass.with(
            class extends ThermostatServer.with(...thermostatServerFeatures) {
              async setpointRaiseLower() { // This method seems to be never called, yet is required to be implemented
                console.log('setpointRaiseLower', arguments);
              }
            },
          ), {
            id: 'main',
            thermostat: {
              systemMode: (() => {
                switch (device.capabilitiesObj?.thermostat_mode?.value) {
                  case 'off': return Thermostat.SystemMode.Off;
                  case 'auto': return Thermostat.SystemMode.Auto;
                  case 'cool': return Thermostat.SystemMode.Cool;
                  case 'heat': return Thermostat.SystemMode.Heat;
                  default: return Thermostat.SystemMode.Heat;
                }
              })(),
              controlSequenceOfOperation: (() => {
                if (device.capabilitiesObj?.thermostat_mode) {
                  if (hasHeat && hasCool) {
                    return Thermostat.ControlSequenceOfOperation.CoolingAndHeating;
                  } else if (hasHeat) {
                    return Thermostat.ControlSequenceOfOperation.HeatingOnly;
                  }
                } else {
                  return Thermostat.ControlSequenceOfOperation.HeatingOnly;
                }
              })(),
              occupiedHeatingSetpoint: typeof device.capabilitiesObj?.target_temperature?.value === 'number'
                ? Math.round(device.capabilitiesObj?.target_temperature?.value * 100)
                : 0,
              minHeatSetpointLimit: typeof device.capabilitiesObj?.target_temperature?.min === 'number'
                ? Math.round(device.capabilitiesObj?.target_temperature?.min * 100)
                : 0,
              absMinHeatSetpointLimit: typeof device.capabilitiesObj?.target_temperature?.min === 'number'
                ? Math.round(device.capabilitiesObj?.target_temperature?.min * 100)
                : 0,
              maxHeatSetpointLimit: typeof device.capabilitiesObj?.target_temperature?.max === 'number'
                ? Math.round(device.capabilitiesObj?.target_temperature?.max * 100)
                : 10000,
              absMaxHeatSetpointLimit: typeof device.capabilitiesObj?.target_temperature?.max === 'number'
                ? Math.round(device.capabilitiesObj?.target_temperature?.max * 100)
                : 10000,
              ...(hasAuto ? { minSetpointDeadBand: 0 } : {}),
              localTemperature: typeof device.capabilitiesObj?.measure_temperature?.value === 'number'
                ? Math.round(device.capabilitiesObj.measure_temperature.value * 100)
                : null,
            },
          });
          await registerEndpoint(endpoint);

          // Local source reports must not become commands that override the Homey schedule.
          endpoint.events.thermostat.events.occupiedHeatingSetpoint$Changing?.on(async (value, oldValue, context) => {
            if (context.offline) {
              return;
            }

            await device.setCapabilityValue({
              capabilityId: 'target_temperature',
              value: value / 100,
            });
          });

          endpoint.events.thermostat.events.occupiedCoolingSetpoint$Changing?.on(async (value, oldValue, context) => {
            if (context.offline) {
              return;
            }

            if (device.capabilitiesObj?.['target_temperature.cool']) {
              await device.setCapabilityValue({
                capabilityId: 'target_temperature.cool',
                value: value / 100,
              });
            }
          });

          endpoint.events.thermostat.events.systemMode$Changing.on(async (value, oldValue, context) => {
            if (context.offline) {
              return;
            }

            if (!device.capabilitiesObj?.thermostat_mode) {
              throw new Error('Cannot Change Thermostat Mode');
            };

            switch (value) {
              case Thermostat.SystemMode.Off: {
                await device.setCapabilityValue({
                  capabilityId: 'thermostat_mode',
                  value: 'off',
                });
                break;
              }
              case Thermostat.SystemMode.Auto: {
                await device.setCapabilityValue({
                  capabilityId: 'thermostat_mode',
                  value: 'auto',
                });
                break;
              }
              case Thermostat.SystemMode.Heat: {
                await device.setCapabilityValue({
                  capabilityId: 'thermostat_mode',
                  value: 'heat',
                });
                break;
              }
              case Thermostat.SystemMode.Cool: {
                await device.setCapabilityValue({
                  capabilityId: 'thermostat_mode',
                  value: 'cool',
                });
                break;
              }
            }
          });

          makeCapabilityInstance('measure_temperature', async value => {
            await endpoint.set({
              thermostat: {
                localTemperature: typeof value === 'number'
                  ? Math.round(value * 100)
                  : null,
              },
            });
          });

          makeCapabilityInstance('target_temperature', async value => {
            await endpoint.set({
              thermostat: {
                occupiedHeatingSetpoint: typeof value === 'number'
                  ? Math.round(value * 100)
                  : null,
              },
            });
          });

          makeCapabilityInstance('thermostat_mode', async value => {
            switch (value) {
              case 'off': {
                await endpoint.set({
                  thermostat: {
                    systemMode: Thermostat.SystemMode.Off,
                  },
                });
                break;
              }
              case 'auto': {
                await endpoint.set({
                  thermostat: {
                    systemMode: Thermostat.SystemMode.Auto,
                  },
                });
                break;
              }
              case 'heat': {
                await endpoint.set({
                  thermostat: {
                    systemMode: Thermostat.SystemMode.Heat,
                  },
                });
                break;
              }
              case 'cool': {
                await endpoint.set({
                  thermostat: {
                    systemMode: Thermostat.SystemMode.Cool,
                  },
                });
                break;
              }
            }
          });

          // Humidity
          if (device.capabilitiesObj?.measure_humidity) {
            const endpoint = new Endpoint(HumiditySensorDevice.with(RelativeHumidityMeasurementServer), {
              id: 'measure_humidity',
              relativeHumidityMeasurement: {
                measuredValue: typeof device.capabilitiesObj?.measure_humidity?.value === 'number'
                  ? Math.round(device.capabilitiesObj?.measure_humidity?.value * 100)
                  : null,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('measure_humidity', async value => {
              await endpoint.set({
                relativeHumidityMeasurement: {
                  measuredValue: typeof value === 'number'
                    ? Math.round(value * 100)
                    : null,
                },
              });
            });
          }

          break;
        }

        case 'lock': {
          if (device.capabilitiesObj?.locked) {
            // Homey exposes lock/unlock; credential and scheduling features remain on the physical lock.
            class HomeyDoorLockServer extends DoorLockServer.with() {
              async lockDoor() {
                await device.setCapabilityValue({
                  capabilityId: 'locked',
                  value: true,
                });
              }
              async unlockDoor() {
                await device.setCapabilityValue({
                  capabilityId: 'locked',
                  value: false,
                });
              }
            }

            const endpoint = new Endpoint(DoorLockDevice.with(HomeyDoorLockServer), {
              id: 'main',
              doorLock: {
                lockType: DoorLock.LockType.Other,
                operatingMode: DoorLock.OperatingMode.Normal,
                lockState: typeof device.capabilitiesObj?.locked?.value === true
                  ? DoorLock.LockState.Locked
                  : DoorLock.LockState.Unlocked,
                actuatorEnabled: true,
              }
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('locked', async value => {
              await endpoint.set({
                doorLock: {
                  lockState: value === true
                    ? DoorLock.LockState.Locked
                    : DoorLock.LockState.Unlocked,
                },
              });
            });
          }

          break;
        }

        case 'windowcoverings':
        case 'blinds':
        case 'shutterblinds':
        case 'curtain': {
          if (device.capabilitiesObj?.windowcoverings_set) {
            const HomeyWindowConveringServer = class extends WindowCoveringServer.with(
              WindowCovering.Feature.Lift,
              WindowCovering.Feature.PositionAwareLift,
            ) {

              async goToLiftPercentage({ liftPercent100thsValue }) {
                await device.setCapabilityValue({
                  capabilityId: 'windowcoverings_set',
                  value: 1 - scaleNumber(liftPercent100thsValue, 0, 10000, 0, 1),
                });
              }

            }

            const endpoint = new Endpoint(WindowCoveringDevice.with(HomeyWindowConveringServer), {
              id: 'main',
              windowCovering: {
                targetPositionLiftPercent100ths: typeof device.capabilitiesObj?.windowcoverings_set?.value === 'number'
                  ? 10000 - scaleNumber(device.capabilitiesObj?.windowcoverings_set?.value, 0, 1, 0, 10000)
                  : 5000,
                currentPositionLiftPercent100ths: typeof device.capabilitiesObj?.windowcoverings_set?.value === 'number'
                  ? 10000 - scaleNumber(device.capabilitiesObj?.windowcoverings_set?.value, 0, 1, 0, 10000)
                  : null,
              }
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('windowcoverings_set', async value => {
              await endpoint.set({
                windowCovering: {
                  currentPositionLiftPercent100ths: typeof value === 'number'
                    ? 10000 - scaleNumber(value, 0, 1, 0, 10000)
                    : 5000,
                  targetPositionLiftPercent100ths: typeof value === 'number'
                    ? 10000 - scaleNumber(value, 0, 1, 0, 10000)
                    : 5000,
                },
              });
            });
          }

          else if (device.capabilitiesObj?.windowcoverings_state) {
            const HomeyWindowConveringServer = class extends WindowCoveringServer.with(
              WindowCovering.Feature.Lift,
            ) {

              async upOrOpen() {
                await device.setCapabilityValue({
                  capabilityId: 'windowcoverings_state',
                  value: 'up',
                });
              }

              async downOrClose() {
                await device.setCapabilityValue({
                  capabilityId: 'windowcoverings_state',
                  value: 'down',
                });
              }

              async stopMotion() {
                await device.setCapabilityValue({
                  capabilityId: 'windowcoverings_state',
                  value: 'idle',
                });
              }

            }

            const endpoint = new Endpoint(WindowCoveringDevice.with(HomeyWindowConveringServer), {
              id: 'main',
              windowCovering: {
                operationalStatus: {
                  lift: (() => {
                    switch (device.capabilitiesObj?.windowcoverings_state?.value) {
                      case 'up': return WindowCovering.MovementStatus.Opening;
                      case 'down': return WindowCovering.MovementStatus.Closing;
                      case 'idle': return WindowCovering.MovementStatus.Stopped;
                      default: return WindowCovering.MovementStatus.Stopped;
                    }
                  })(),
                },
              }
            });
            await registerEndpoint(endpoint);

            // Note: The status seems to be synced, but it doesn't show up in Apple Home.
            makeCapabilityInstance('windowcoverings_state', async value => {
              switch (value) {
                case 'up': {
                  await endpoint.set({
                    windowCovering: {
                      operationalStatus: {
                        lift: WindowCovering.MovementStatus.Opening,
                      },
                    },
                  });
                  break;
                }
                case 'down': {
                  await endpoint.set({
                    windowCovering: {
                      operationalStatus: {
                        lift: WindowCovering.MovementStatus.Closing,
                      },
                    },
                  });
                  break;
                }
                case 'idle': {
                  await endpoint.set({
                    windowCovering: {
                      operationalStatus: {
                        lift: WindowCovering.MovementStatus.Stopped,
                      },
                    },
                  });
                  break;
                }
              }
            });
          }

          break;
        }

        case 'sensor': {
          if (device.capabilitiesObj?.measure_temperature) {
            const endpoint = new Endpoint(TemperatureSensorDevice.with(TemperatureMeasurementServer), {
              id: 'measure_temperature',
              temperatureMeasurement: {
                measuredValue: typeof device.capabilitiesObj?.measure_temperature?.value === 'number'
                  ? Math.round(device.capabilitiesObj?.measure_temperature?.value * 100)
                  : null,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('measure_temperature', async value => {
              await endpoint.set({
                temperatureMeasurement: {
                  measuredValue: typeof value === 'number'
                    ? Math.round(value * 100)
                    : null,
                },
              });
            });
          }

          if (device.capabilitiesObj?.measure_humidity) {
            const endpoint = new Endpoint(HumiditySensorDevice.with(RelativeHumidityMeasurementServer), {
              id: 'measure_humidity',
              relativeHumidityMeasurement: {
                measuredValue: typeof device.capabilitiesObj?.measure_humidity?.value === 'number'
                  ? Math.round(device.capabilitiesObj?.measure_humidity?.value * 100)
                  : null,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('measure_humidity', async value => {
              await endpoint.set({
                relativeHumidityMeasurement: {
                  measuredValue: typeof value === 'number'
                    ? Math.round(value * 100)
                    : null,
                },
              });
            });
          }

          if (device.capabilitiesObj?.measure_co) {
            const endpoint = new Endpoint(SmokeCoAlarmDevice.with(CarbonMonoxideConcentrationMeasurementServer.with('NumericMeasurement')), {
              id: 'measure_co',
              carbonMonoxideConcentrationMeasurement: {
                measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ppm,
                measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
                measuredValue: typeof device.capabilitiesObj?.measure_co?.value === 'number'
                  ? Math.round(device.capabilitiesObj?.measure_co?.value)
                  : null,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('measure_co', async value => {
              await endpoint.set({
                carbonMonoxideConcentrationMeasurement: {
                  measuredValue: typeof value === 'number'
                    ? Math.round(value)
                    : null,
                },
              });
            });
          }

          if (device.capabilitiesObj?.measure_co2) {
            const endpoint = new Endpoint(AirQualitySensorDevice.with(CarbonDioxideConcentrationMeasurementServer.with('NumericMeasurement')), {
              id: 'measure_co2',
              airQuality: { airQuality: AirQuality.AirQualityEnum.Unknown },
              carbonDioxideConcentrationMeasurement: {
                measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ppm,
                measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
                measuredValue: typeof device.capabilitiesObj?.measure_co2?.value === 'number'
                  ? Math.round(device.capabilitiesObj?.measure_co2?.value)
                  : null,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('measure_co2', async value => {
              await endpoint.set({
                carbonDioxideConcentrationMeasurement: {
                  measuredValue: typeof value === 'number'
                    ? Math.round(value)
                    : null,
                },
              });
            });
          }

          if (device.capabilitiesObj?.measure_pm10) {
            const endpoint = new Endpoint(AirQualitySensorDevice.with(Pm10ConcentrationMeasurementServer.with('NumericMeasurement')), {
              id: 'measure_pm10',
              airQuality: { airQuality: AirQuality.AirQualityEnum.Unknown },
              pm10ConcentrationMeasurement: {
                measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ugm3,
                measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
                measuredValue: typeof device.capabilitiesObj?.measure_pm10?.value === 'number'
                  ? Math.round(device.capabilitiesObj?.measure_pm10?.value)
                  : null,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('measure_pm10', async value => {
              await endpoint.set({
                pm10ConcentrationMeasurement: {
                  measuredValue: typeof value === 'number'
                    ? Math.round(value)
                    : null,
                },
              });
            });
          }

          if (device.capabilitiesObj?.measure_pm25) {
            const endpoint = new Endpoint(AirQualitySensorDevice.with(Pm25ConcentrationMeasurementServer.with('NumericMeasurement')), {
              id: 'measure_pm25',
              airQuality: { airQuality: AirQuality.AirQualityEnum.Unknown },
              pm25ConcentrationMeasurement: {
                measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ugm3,
                measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
                measuredValue: typeof device.capabilitiesObj?.measure_pm25?.value === 'number'
                  ? Math.round(device.capabilitiesObj?.measure_pm25?.value)
                  : null,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('measure_pm25', async value => {
              await endpoint.set({
                pm25ConcentrationMeasurement: {
                  measuredValue: typeof value === 'number'
                    ? Math.round(value)
                    : null,
                },
              });
            });
          }

          if (device.capabilitiesObj?.measure_luminance) {
            const endpoint = new Endpoint(LightSensorDevice, {
              id: 'measure_luminance',
              illuminanceMeasurement: {
                measuredValue: typeof device.capabilitiesObj?.measure_luminance?.value === 'number' && device.capabilitiesObj?.measure_luminance?.value > 0
                  ? 10000 * Math.log10(device.capabilitiesObj?.measure_luminance?.value) + 1
                  : null,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('measure_luminance', async value => {
              await endpoint.set({
                illuminanceMeasurement: {
                  measuredValue: typeof value === 'number' && value > 0
                    ? 10000 * Math.log10(value) + 1
                    : null,
                },
              });
            });
          }

          if (device.capabilitiesObj?.alarm_motion) {
            const endpoint = new Endpoint(OccupancySensorDevice.with(
              OccupancySensingServer.with(OccupancySensing.Feature.PassiveInfrared)
            ), {
              id: 'alarm_motion',
              occupancySensing: {
                occupancy: {
                  occupied: device.capabilitiesObj?.alarm_motion?.value === true,
                },
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('alarm_motion', async value => {
              await endpoint.set({
                occupancySensing: {
                  occupancy: {
                    occupied: value === true,
                  },
                },
              });
            });
          }

          if (device.capabilitiesObj?.alarm_occupancy) {
            const endpoint = new Endpoint(OccupancySensorDevice.with(
              OccupancySensingServer.with(OccupancySensing.Feature.Ultrasonic)
            ), {
              id: 'alarm_occupancy',
              occupancySensing: {
                occupancySensorType: OccupancySensing.OccupancySensorType.Ultrasonic,
                occupancy: {
                  occupied: device.capabilitiesObj?.alarm_occupancy?.value === true,
                },
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('alarm_occupancy', async value => {
              await endpoint.set({
                occupancySensing: {
                  occupancy: {
                    occupied: value === true,
                  },
                },
              });
            });
          }

          if (device.capabilitiesObj?.alarm_contact) { // TODO: See this working in Apple Home
            const endpoint = new Endpoint(ContactSensorDevice.with(BooleanStateServer), {
              id: 'alarm_contact',
              booleanState: {
                stateValue: device.capabilitiesObj?.alarm_contact?.value === false,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('alarm_contact', async value => {
              await endpoint.set({
                booleanState: {
                  stateValue: value === false,
                },
              });
            });
          }

          if (device.capabilitiesObj?.alarm_smoke) {
            const endpoint = new Endpoint(SmokeCoAlarmDevice.with(SmokeCoAlarmServer.with('SmokeAlarm')), {
              id: 'alarm_smoke',
              smokeCoAlarm: {
                smokeState: device.capabilitiesObj?.alarm_smoke?.value === true
                  ? SmokeCoAlarm.AlarmState.Critical
                  : SmokeCoAlarm.AlarmState.Normal,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('alarm_smoke', async value => {
              await endpoint.set({
                smokeCoAlarm: {
                  smokeState: value === true
                    ? SmokeCoAlarm.AlarmState.Critical
                    : SmokeCoAlarm.AlarmState.Normal,
                },
              });
            });
          }

          break;
        }
        default: {
          // If the device has an onoff capability, add it as an OnOffPlugInUnitDevice.
          if (device.capabilitiesObj?.onoff) {
            class HomeyOnOffServer extends OnOffServer {
              async on() {
                await device.setCapabilityValue({
                  capabilityId: 'onoff',
                  value: true,
                })
              }

              async off() {
                await device.setCapabilityValue({
                  capabilityId: 'onoff',
                  value: false,
                });
              }
            }

            const endpoint = new Endpoint(OnOffPlugInUnitDevice.with(HomeyOnOffServer), {
              id: 'main',
              onOff: {
                onOff: device.capabilitiesObj?.onoff?.value ?? false,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('onoff', async value => {
              await endpoint.set({
                onOff: {
                  onOff: value ?? false,
                },
              });
            });
          }

          break;
        }
      }
    });
  }

  async __uninitEndpoint(device) {
    return await this.__queue.add(async () => {
      this.debug(`Uninitializing Endpoint for ${device.name} (${device.id})`);

      // Subscriptions belong to this endpoint and must be recreated when sharing resumes.
      const capabilityInstances = this.deviceCapabilityInstances[device.id] ?? {};

      for (const instance of Object.values(capabilityInstances)) {
        instance.destroy();
      }

      delete this.deviceCapabilityInstances[device.id];

      const deviceEndpoint = this.deviceEndpoints[device.id];

      if (deviceEndpoint) {
        await deviceEndpoint.delete();
      }

      delete this.deviceEndpoints[device.id];
      delete this.deviceEndpointInstances[device.id];
    });
  }

  // Stored Matter values override construction options. Reapply the current Homey
  // snapshot after adding the endpoint, including its label and capability state.
  static async applyCreationState(endpoint) {
    const state = {};

    for (const type of Object.values(endpoint.behaviors.supported)) {
      const options = endpoint.behaviors.optionsFor(type);

      if (options !== undefined) {
        state[type.id] = options;
      }
    }

    await endpoint.set(state);
  }

  pauseQueue() {
    this.__queue.pause();
  }

  resumeQueue() {
    this.__queue.start();
  }

}

function scaleNumber(value, minInput, maxInput, minOutput, maxOutput) {
  const scaledValue = ((value - minInput) / (maxInput - minInput)) * (maxOutput - minOutput) + minOutput;
  return Math.min(Math.max(scaledValue, minOutput), maxOutput);
}

function scaleAndRoundNumber(...props) {
  return Math.round(scaleNumber(...props));
}

// Homey's light_temperature goes from 0 (coldest) to 1 (warmest) of the light's own range, without Kelvin values.
// Matter uses mireds (1,000,000 / Kelvin), so it's mapped onto a typical white range of 6500 K to 2000 K.
const COLOR_TEMPERATURE_MIN_MIREDS = 153; // 6500 K
const COLOR_TEMPERATURE_MAX_MIREDS = 500; // 2000 K
const COLOR_TEMPERATURE_DEFAULT_MIREDS = 250; // 4000 K, when the light hasn't reported a temperature yet

function lightTemperatureToMireds(value) {
  if (typeof value !== 'number') return COLOR_TEMPERATURE_DEFAULT_MIREDS;
  return scaleAndRoundNumber(value, 0, 1, COLOR_TEMPERATURE_MIN_MIREDS, COLOR_TEMPERATURE_MAX_MIREDS);
}

function miredsToLightTemperature(mireds) {
  return scaleNumber(mireds, COLOR_TEMPERATURE_MIN_MIREDS, COLOR_TEMPERATURE_MAX_MIREDS, 0, 1);
}

function ellipseString(value, maxLength = 32) {
  if (typeof value !== 'string') return null;
  if (value.length > maxLength) return value.substring(0, maxLength - 3) + '…';
  return value;
}
