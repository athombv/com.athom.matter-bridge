import { FanMapping } from './mappings/FanMapping.mjs';
import { PowerTelemetry } from './mappings/PowerTelemetry.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import PQueue from 'p-queue';
import { runInMicrotask } from './runInMicrotask.mjs';
import { Endpoint, Environment, StorageService, ServerNode, VendorId } from '@matter/main';
import { BridgedNodeEndpoint } from '@matter/main/endpoints/bridged-node';
import { BridgeCommissioningServer } from './BridgeCommissioningServer.mjs';

import { ElectricalPowerMeasurement } from '@matter/main/clusters/electrical-power-measurement';
import { AirQuality } from '@matter/main/clusters/air-quality';
import { ConcentrationMeasurement } from '@matter/main/clusters/concentration-measurement';
import { Thermostat } from '@matter/main/clusters/thermostat';
import { ColorControl } from '@matter/main/clusters/color-control';
import { SmokeCoAlarm } from '@matter/main/clusters/smoke-co-alarm';
import { OccupancySensing } from '@matter/main/clusters/occupancy-sensing';
import { WindowCovering } from '@matter/main/clusters/window-covering';
import { DoorLock } from '@matter/main/clusters/door-lock';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { OnOffPlugInUnitDevice } from '@matter/main/devices/on-off-plug-in-unit';
import { OnOffLightDevice } from '@matter/main/devices/on-off-light';
import { DimmableLightDevice } from '@matter/main/devices/dimmable-light';
import { ColorTemperatureLightDevice } from '@matter/main/devices/color-temperature-light';
import { ExtendedColorLightDevice } from '@matter/main/devices/extended-color-light';
import { TemperatureSensorDevice } from '@matter/main/devices/temperature-sensor';
import { HumiditySensorDevice } from '@matter/main/devices/humidity-sensor';
import { ThermostatDevice } from '@matter/main/devices/thermostat';
import { RoomAirConditionerDevice } from '@matter/main/devices/room-air-conditioner';
import { SmokeCoAlarmDevice } from '@matter/main/devices/smoke-co-alarm';
import { AirQualitySensorDevice } from '@matter/main/devices/air-quality-sensor';
import { OccupancySensorDevice } from '@matter/main/devices/occupancy-sensor';
import { ContactSensorDevice } from '@matter/main/devices/contact-sensor';
import { WaterLeakDetectorDevice } from '@matter/main/devices/water-leak-detector';
import { WindowCoveringDevice } from '@matter/main/devices/window-covering';
import { DoorLockDevice } from '@matter/main/devices/door-lock';
import { LightSensorDevice } from '@matter/main/devices/light-sensor';
import { OnOffServer } from '@matter/main/behaviors/on-off';
import { LevelControlServer } from '@matter/main/behaviors/level-control';
import { ColorControlServer } from '@matter/main/behaviors/color-control';
import { TemperatureMeasurementServer } from '@matter/main/behaviors/temperature-measurement';
import { RelativeHumidityMeasurementServer } from '@matter/main/behaviors/relative-humidity-measurement';
import { CarbonMonoxideConcentrationMeasurementServer } from '@matter/main/behaviors/carbon-monoxide-concentration-measurement';
import { CarbonDioxideConcentrationMeasurementServer } from '@matter/main/behaviors/carbon-dioxide-concentration-measurement';
import { Pm10ConcentrationMeasurementServer } from '@matter/main/behaviors/pm10-concentration-measurement';
import { Pm25ConcentrationMeasurementServer } from '@matter/main/behaviors/pm25-concentration-measurement';
import { SmokeCoAlarmServer } from '@matter/main/behaviors/smoke-co-alarm';
import { ElectricalPowerMeasurementServer } from '@matter/main/behaviors/electrical-power-measurement';
import { ThermostatServer } from '@matter/main/behaviors/thermostat';
import { BooleanStateServer } from '@matter/main/behaviors/boolean-state';
import { WindowCoveringServer } from '@matter/main/behaviors/window-covering';
import { DoorLockServer } from '@matter/main/behaviors/door-lock';
import { OccupancySensingServer } from '@matter/main/behaviors/occupancy-sensing';
import { MeasurementType } from '@matter/main/types';

export class MatterBridgeServer {
  // Homey values may be null; these Matter mappings require a known boolean to report reachability.
  static #capabilitiesRequiringKnownBoolean = [
    'onoff', 'alarm_motion', 'alarm_occupancy', 'alarm_contact', 'alarm_smoke', 'alarm_water', 'alarm_battery',
  ];

  static getDeviceSupport(device) {
    const capabilities = device.capabilitiesObj ?? {};
    const deviceClass = device.virtualClass || device.class;
    const candidates = new Set([
      'measure_temperature', 'measure_humidity', 'measure_co', 'measure_co2', 'measure_pm10',
      'measure_pm25', 'measure_luminance', 'alarm_motion', 'alarm_occupancy', 'alarm_contact',
      'alarm_smoke', 'alarm_water', 'measure_power', 'measure_battery', 'alarm_battery',
      PowerTelemetry.importedCapability(capabilities), 'meter_power.exported',
    ]);

    switch (deviceClass) {
      case 'fan': {
        candidates.add('onoff');
        const speed = FanMapping.speedCapability(capabilities);

        if (speed) {
          candidates.add(speed.id);
        }
        break;
      }
      case 'socket': {
        candidates.add('onoff');
        candidates.add('measure_power');
        break;
      }
      case 'light': {
        candidates.add('onoff');
        candidates.add('dim');
        const hasColor = capabilities.light_hue && capabilities.light_saturation;
        const incompleteColor = !hasColor && (capabilities.light_hue || capabilities.light_saturation);

        if (hasColor) {
          candidates.add('light_hue');
          candidates.add('light_saturation');
        }
        if (!incompleteColor) {
          candidates.add('light_temperature');
        }
        if (hasColor && capabilities.light_temperature) {
          candidates.add('light_mode');
        }
        break;
      }
      case 'thermostat':
      case 'heatpump':
      case 'heater':
      case 'airconditioning': {
        const mode = capabilities.thermostat_mode;
        const modes = mode?.values?.map((value) => {
          return value.id;
        }) ?? [];
        const heating = !mode || modes.includes('heat');
        const cooling = modes.includes('cool');
        const hasSupportedMode = heating || cooling || modes.includes('off') || modes.includes('auto');

        if (!hasSupportedMode) {
          candidates.clear();
          break;
        }
        candidates.add('thermostat_mode');
        if (heating) {
          candidates.add('target_temperature');
        }
        if (cooling) {
          candidates.add(capabilities['target_temperature.cool'] ? 'target_temperature.cool' : 'target_temperature');
        }
        if (deviceClass === 'airconditioning') {
          candidates.add('onoff');
        }
        break;
      }
      case 'lock': {
        candidates.add('locked');
        break;
      }
      case 'windowcoverings':
      case 'blinds':
      case 'shutterblinds':
      case 'curtain': {
        candidates.add(capabilities.windowcoverings_set ? 'windowcoverings_set' : 'windowcoverings_state');
        break;
      }
      default: {
        candidates.add('onoff');
      }
    }

    const supportedCapabilities = [];
    const unsupportedCapabilities = [];

    for (const id of Object.keys(capabilities)) {
      if (candidates.has(id)) {
        supportedCapabilities.push(id);
      } else {
        unsupportedCapabilities.push(id);
      }
    }

    return { canShare: supportedCapabilities.length > 0, supportedCapabilities, unsupportedCapabilities };
  }

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
      qrPairingCode: commissioned
        ? null
        : (this.serverNode?.state?.commissioning?.pairingCodes?.qrPairingCode ?? null),
      manualPairingCode: commissioned
        ? null
        : (this.serverNode?.state?.commissioning?.pairingCodes?.manualPairingCode ?? null),
      pairing,
    };
  }

  async startPairing() {
    return await this.pairingQueue.add(async () => {
      if (!this.serverNode?.lifecycle.isOnline) {
        throw new Error('Server Not Ready');
      }
      await this.serverNode.act(async (agent) => {
        await agent.get(BridgeCommissioningServer).startLocalPairing();
      });
      return await this.getState();
    });
  }

  async stopPairing() {
    return await this.pairingQueue.add(async () => {
      if (!this.serverNode?.lifecycle.isOnline) {
        throw new Error('Server Not Ready');
      }
      await this.serverNode.act(async (agent) => {
        await agent.get(BridgeCommissioningServer).stopLocalPairing();
      });
      return await this.getState();
    });
  }

  async stop() {
    await this.pairingQueue.onIdle();
    if (this.onDeviceDelete) {
      this.api.devices.off('device.delete', this.onDeviceDelete);
    }
    if (this.onDeviceUpdate) {
      this.api.devices.off('device.update', this.onDeviceUpdate);
    }
    this.__queue.start();
    await this.__queue.onIdle();
    for (const instances of Object.values(this.deviceCapabilityInstances)) {
      for (const instance of Object.values(instances)) {
        await instance.destroy();
      }
    }
    this.deviceCapabilityInstances = {};
    if (this.serverNode) {
      await this.serverNode.close();
    }
    this.serverNode = null;
  }

  async start() {
    if (this.serverNode) {
      throw new Error('Already Started Server');
    }

    // Create the Server
    this.serverNode = await ServerNode.create(
      ServerNode.RootEndpoint.with(BridgeCommissioningServer),
      {
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
          vendorName: MatterBridgeServer.#ellipsizeString(this.vendorName),
          vendorId: VendorId(this.vendorId),
          nodeLabel: MatterBridgeServer.#ellipsizeString(this.productName),
          productName: MatterBridgeServer.#ellipsizeString(this.productName),
          productLabel: MatterBridgeServer.#ellipsizeString(this.productName),
          productId: this.productId,
          serialNumber: MatterBridgeServer.#ellipsizeString(this.serialNumber),
          uniqueId: MatterBridgeServer.#ellipsizeString(this.uniqueId),
        },
      },
    );

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
      if (!this.enabledDeviceIds.has(device.id)) {
        continue;
      }
      await this.__initEndpoint(device).catch((err) => {
        this.debug(`Error initializing endpoint for device ${device.id} during startup`, err);
      });

      if (device.ready === true) {
        await this.__initDevice(device).catch((err) => {
          this.debug(`Error initializing device ${device.id} during startup`, err);
        });
      }
    }

    // Subscribe to Device events
    this.onDeviceDelete = (device) => {
      if (!this.enabledDeviceIds.has(device.id)) {
        return;
      }
      if (!this.deviceEndpoints[device.id]) {
        return;
      }

      runInMicrotask(async () => {
        await this.__uninitEndpoint(device);
      }).catch((err) => {
        this.debug(`Error uninitializing device ${device.id} on delete`, err);
      });
    };
    this.onDeviceUpdate = (device) => {
      if (!this.enabledDeviceIds.has(device.id)) {
        return;
      }

      this.__queue.add(async () => {
        const endpoint = this.deviceEndpoints[device.id];

        if (!this.enabledDeviceIds.has(device.id) || !endpoint) {
          return;
        }

        const nodeLabel = MatterBridgeServer.#ellipsizeString(device.name);

        if (endpoint.state.bridgedDeviceBasicInformation.nodeLabel !== nodeLabel) {
          await endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel } });
        }

        await this.#updateDeviceReachability(device);
      }).catch((err) => {
        this.debug(`Error updating device information for ${device.id}`, err);
      });

      if (device.ready === true && !this.deviceEndpointInstances[device.id]) {
        this.debug(`Device ${device.name} (${device.id}) became ready`);
        this.__initDevice(device).catch((err) => {
          this.debug(`Error initializing device ${device.id} on ready:`, err);
        });
      }
    };
    this.api.devices.on('device.delete', this.onDeviceDelete);
    this.api.devices.on('device.update', this.onDeviceUpdate);

    // Finally, start the server
    await this.serverNode.start();
    this.debug('Matter Bridge Server has started.');
  }

  async enableDevice(deviceId) {
    if (this.enabledDeviceIds.has(deviceId)) {
      return;
    }

    const device = await this.api.devices.getDevice({ id: deviceId });
    if (!device) {
      throw new Error(`Device with ID ${deviceId} not found`);
    }

    if (!MatterBridgeServer.getDeviceSupport(device).canShare) {
      throw new Error('This device has no capabilities supported by Matter Bridge.');
    }

    this.enabledDeviceIds.add(deviceId);

    try {
      await this.__initEndpoint(device);

      if (device.ready === true) {
        await this.__initDevice(device);
      }
    } catch (error) {
      this.enabledDeviceIds.delete(deviceId);
      await this.__uninitEndpoint(device).catch((cleanupError) => {
        this.debug(`Error cleaning up failed selection ${deviceId}`, cleanupError);
      });
      throw error;
    }
  }

  async disableDevice(deviceId) {
    if (!this.enabledDeviceIds.has(deviceId)) {
      return;
    }

    const device = await this.api.devices.getDevice({ id: deviceId });
    if (!device) {
      throw new Error(`Device with ID ${deviceId} not found`);
    }

    this.enabledDeviceIds.delete(deviceId);
    await this.__uninitEndpoint(device).catch((err) => {
      this.debug(`Error uninitializing endpoint for device ${device.id} on disable`, err);
    });
  }

  async __initEndpoint(device) {
    return await this.__queue.add(async () => {
      this.debug(`Initializing Endpoint for ${device.name} (${device.id})`);

      // Get the device's driver
      const driver = await device.getDriver();

      // Create a Matter Endpoint
      this.deviceEndpoints[device.id] = new Endpoint(BridgedNodeEndpoint, {
        id: device.id,
        bridgedDeviceBasicInformation: {
          nodeLabel: MatterBridgeServer.#ellipsizeString(device.name),
          reachable: false,
          vendorName: MatterBridgeServer.#ellipsizeString(driver?.ownerName ?? 'Unknown'),
          productName: MatterBridgeServer.#ellipsizeString(driver?.name ?? 'Unknown'),
          serialNumber: MatterBridgeServer.#ellipsizeString(device.id.replaceAll('-', '')), // Max length is 32, so if we remove the dashes from the UUIDv4, it fits!
        },
      });
      await this.aggregatorEndpoint.add(this.deviceEndpoints[device.id]);

      // The current Homey name takes precedence over any restored Matter label.
      await this.deviceEndpoints[device.id].set({
        bridgedDeviceBasicInformation: {
          nodeLabel: MatterBridgeServer.#ellipsizeString(device.name),
          reachable: false,
        },
      });
    });
  }

  async __initDevice(device) {
    return await this.__queue.add(async () => {
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
      const initialUpdates = [];
      let initializing = true;
      const makeCapabilityInstance = (capabilityId, callback) => {
        if (!device.capabilitiesObj?.[capabilityId]) {
          return;
        }

        this.deviceCapabilityInstances[device.id] = this.deviceCapabilityInstances[device.id] || {};
        if (this.deviceCapabilityInstances[device.id][capabilityId]) {
          return;
        }

        const update = async (value) => {
          // Non-nullable Matter attributes retain their last value while the device is unreachable.
          const requiresBoolean = MatterBridgeServer.#capabilitiesRequiringKnownBoolean.includes(capabilityId);

          if (!requiresBoolean || typeof value === 'boolean') {
            await callback(value);
          }

          if (!initializing) {
            await this.#updateDeviceReachability(device);
          }
        };

        initialUpdates.push(async () => {
          await update(device.capabilitiesObj[capabilityId].value);
        });

        this.deviceCapabilityInstances[device.id][capabilityId] = device.makeCapabilityInstance(
          capabilityId,
          (value) => {
            runInMicrotask(async () => {
              await update(value);
            }).catch((err) => {
              this.debug(
                `Error in capability instance callback for device ${device.id} capability ${capabilityId}`,
                err,
              );
            });
          },
        );
      };

      const registerEndpoint = async (endpoint) => {
        this.deviceEndpointInstances[device.id] =
          this.deviceEndpointInstances[device.id] || new Set();
        this.deviceEndpointInstances[device.id].add(endpoint);

        await deviceEndpoint.add(endpoint);
      };

      // Add Matter Behaviors based on the device class and capabilities
      const deviceClass = device.virtualClass || device.class;
      switch (deviceClass) {
        case 'socket': {
          class HomeyOnOffServer extends OnOffServer {
            async on() {
              await device.setCapabilityValue({
                capabilityId: 'onoff',
                value: true,
              });
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

            makeCapabilityInstance('onoff', async (value) => {
              await endpoint.set({
                onOff: {
                  onOff: value ?? false,
                },
              });
            });
          }

          if (device.capabilitiesObj?.measure_power) {
            endpointServers.push(ElectricalPowerMeasurementServer);
            endpointProperties.electricalPowerMeasurement = {
              powerMode: ElectricalPowerMeasurement.PowerMode.Unknown,
              numberOfMeasurementTypes: 1,
              accuracy: [
                {
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
                },
              ],
              activePower:
                typeof device.capabilitiesObj?.measure_power?.value === 'number'
                  ? Math.round(device.capabilitiesObj.measure_power.value * 1000)
                  : null,
            };

            makeCapabilityInstance('measure_power', async (value) => {
              await endpoint.set({
                electricalPowerMeasurement: {
                  activePower: typeof value === 'number' ? Math.round(value * 1000) : null, // W to mW
                },
              });
            });
          }

          const endpoint = new Endpoint(
            OnOffPlugInUnitDevice.with(...endpointServers),
            endpointProperties,
          );
          await registerEndpoint(endpoint);

          break;
        }

        case 'light': {
          const hasHueOrSaturation = !!(
            device.capabilitiesObj?.light_hue || device.capabilitiesObj?.light_saturation
          );
          const supportsHueSaturation = !!(
            device.capabilitiesObj?.light_hue && device.capabilitiesObj?.light_saturation
          );
          const supportsColorTemperature = !!device.capabilitiesObj?.light_temperature &&
            (!hasHueOrSaturation || supportsHueSaturation);
          const supportsBothColorModes = supportsHueSaturation && supportsColorTemperature;

          class HomeyOnOffServer extends OnOffServer {
            async on() {
              await device.setCapabilityValue({
                capabilityId: 'onoff',
                value: true,
              });
            }

            async off() {
              await device.setCapabilityValue({
                capabilityId: 'onoff',
                value: false,
              });
            }
          }

          class HomeyLevelControlServer extends LevelControlServer {
            async moveToLevelWithOnOff({ level }) {
              await MatterBridgeServer.#setSupportedCapabilities(device, {
                onoff: level > 0,
                dim: MatterBridgeServer.#scaleNumber(level, 1, 254, 0, 1),
              });
            }

            async moveToLevel({ level }) {
              await device.setCapabilityValue({
                capabilityId: 'dim',
                value: MatterBridgeServer.#scaleNumber(level, 1, 254, 0, 1),
              });
            }
          }

          class HomeyColorControlServer extends ColorControlServer {
            initialize() {
              super.initialize();

              // Persisted Matter state is loaded before initialization. Homey owns the active mode.
              this.state.colorMode = endpointProperties.colorControl.colorMode;
              this.state.enhancedColorMode = endpointProperties.colorControl.enhancedColorMode;
            }

            async moveToHueAndSaturation({ hue, saturation }) {
              await MatterBridgeServer.#setSupportedCapabilities(device, {
                onoff: true,
                light_hue: MatterBridgeServer.#scaleNumber(hue, 0, 254, 0, 1),
                light_saturation: MatterBridgeServer.#scaleNumber(saturation, 0, 254, 0, 1),
                light_mode: 'color',
              });
            }

            async moveToColorTemperature({ colorTemperatureMireds }) {
              await MatterBridgeServer.#setSupportedCapabilities(device, {
                onoff: true,
                light_temperature: MatterBridgeServer.#scaleNumber(
                  colorTemperatureMireds,
                  1,
                  300,
                  0,
                  1,
                ),
                light_mode: 'temperature',
              });
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

            makeCapabilityInstance('onoff', async (value) => {
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
              currentLevel:
                typeof device.capabilitiesObj.dim.value === 'number'
                  ? MatterBridgeServer.#scaleAndRoundNumber(
                      device.capabilitiesObj.dim.value,
                      0,
                      1,
                      1,
                      254,
                    )
                  : null,
              minLevel: 1,
              maxLevel: 254,
            };

            makeCapabilityInstance('dim', async (value) => {
              await endpoint.set({
                levelControl: {
                  currentLevel:
                    typeof value === 'number'
                      ? MatterBridgeServer.#scaleAndRoundNumber(value, 0, 1, 1, 254)
                      : null,
                },
              });
            });
          }

          if (supportsHueSaturation) {
            endpointProperties.colorControl = {
              ...endpointProperties.colorControl,
              colorMode: ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
              enhancedColorMode: ColorControl.EnhancedColorMode.CurrentHueAndCurrentSaturation,
              currentHue:
                MatterBridgeServer.#scaleAndRoundNumber(
                  device.capabilitiesObj?.light_hue?.value,
                  0,
                  1,
                  0,
                  254,
                ) ?? 0,
              currentSaturation:
                MatterBridgeServer.#scaleAndRoundNumber(
                  device.capabilitiesObj?.light_saturation?.value,
                  0,
                  1,
                  0,
                  254,
                ) ?? 0,
            };

            makeCapabilityInstance('light_hue', async (value) => {
              await endpoint.set({
                colorControl: {
                  currentHue: MatterBridgeServer.#scaleAndRoundNumber(value, 0, 1, 0, 254) ?? 0,
                },
              });
            });

            makeCapabilityInstance('light_saturation', async (value) => {
              await endpoint.set({
                colorControl: {
                  currentSaturation:
                    MatterBridgeServer.#scaleAndRoundNumber(value, 0, 1, 0, 254) ?? 0,
                },
              });
            });
          }

          if (supportsColorTemperature) {
            endpointProperties.colorControl = {
              ...endpointProperties.colorControl,
              colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
              enhancedColorMode: ColorControl.EnhancedColorMode.ColorTemperatureMireds,
              colorTemperatureMireds:
                MatterBridgeServer.#scaleAndRoundNumber(
                  device.capabilitiesObj?.light_temperature?.value,
                  0,
                  1,
                  1,
                  300,
                ) ?? 150,
              colorTempPhysicalMinMireds: 1,
              colorTempPhysicalMaxMireds: 300,
              coupleColorTempToLevelMinMireds: 1,
            };

            makeCapabilityInstance('light_temperature', async (value) => {
              await endpoint.set({
                colorControl: {
                  colorTemperatureMireds:
                    MatterBridgeServer.#scaleAndRoundNumber(value, 0, 1, 1, 300) ?? 150,
                },
              });
            });
          }

          if (supportsHueSaturation && !supportsColorTemperature) {
            endpointClass = DimmableLightDevice;
            endpointServers.push(HomeyColorControlServer.with(ColorControl.Feature.HueSaturation)); // Only Color
          } else if (!supportsHueSaturation && supportsColorTemperature) {
            endpointClass = ColorTemperatureLightDevice;
            endpointServers.push(
              HomeyColorControlServer.with(ColorControl.Feature.ColorTemperature),
            ); // Only Temperature
          } else if (supportsBothColorModes) {
            endpointClass = ExtendedColorLightDevice;
            endpointServers.push(
              HomeyColorControlServer.with(
                ColorControl.Feature.HueSaturation,
                ColorControl.Feature.ColorTemperature,
              ),
            ); // Both Color & Temperature
          }

          if (supportsBothColorModes) {
            switch (device.capabilitiesObj?.light_mode?.value) {
              case null:
              case 'color': {
                endpointProperties.colorControl.colorMode =
                  ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
                endpointProperties.colorControl.enhancedColorMode =
                  ColorControl.EnhancedColorMode.CurrentHueAndCurrentSaturation;
                break;
              }
              case 'temperature': {
                endpointProperties.colorControl.colorMode =
                  ColorControl.ColorMode.ColorTemperatureMireds;
                endpointProperties.colorControl.enhancedColorMode =
                  ColorControl.EnhancedColorMode.ColorTemperatureMireds;
                break;
              }
            }
          }

          if (supportsBothColorModes && device.capabilitiesObj?.light_mode) {
            makeCapabilityInstance('light_mode', async (value) => {
              // Both Matter mode attributes must identify the same active color representation.
              switch (value) {
                case 'color': {
                  await endpoint.set({
                    colorControl: {
                      colorMode: ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
                      enhancedColorMode:
                        ColorControl.EnhancedColorMode.CurrentHueAndCurrentSaturation,
                    },
                  });
                  break;
                }
                case 'temperature': {
                  await endpoint.set({
                    colorControl: {
                      colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
                      enhancedColorMode: ColorControl.EnhancedColorMode.ColorTemperatureMireds,
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
          const modeCapability = device.capabilitiesObj.thermostat_mode;
          const modes = modeCapability?.values ?? [];
          const hasHeat =
            !modeCapability ||
            modes.some((value) => {
              return value.id === 'heat';
            });
          const hasCool = modes.some((value) => {
            return value.id === 'cool';
          });
          const hasAuto = modes.some((value) => {
            return value.id === 'auto';
          });
          const hasOff =
            !modeCapability ||
            modes.some((value) => {
              return value.id === 'off';
            });

          if (!hasHeat && !hasCool && !hasAuto && !hasOff) {
            return;
          }

          const thermostatServerFeatures = [];
          if (hasHeat) {
            thermostatServerFeatures.push(Thermostat.Feature.Heating);
          }
          if (hasCool) {
            thermostatServerFeatures.push(Thermostat.Feature.Cooling);
          }
          if (hasAuto) {
            thermostatServerFeatures.push(Thermostat.Feature.AutoMode);
          }

          const EndpointClass =
            deviceClass === 'airconditioning' ? RoomAirConditionerDevice : ThermostatDevice;

          const modeValues = {
            off: Thermostat.SystemMode.Off,
            auto: Thermostat.SystemMode.Auto,
            heat: Thermostat.SystemMode.Heat,
            cool: Thermostat.SystemMode.Cool,
          };
          const coolingCapability = device.capabilitiesObj['target_temperature.cool']
            ? 'target_temperature.cool'
            : 'target_temperature';
          const setpoints = {};
          for (const [kind, capabilityId, supported] of [
            ['Heat', 'target_temperature', hasHeat],
            ['Cool', coolingCapability, hasCool],
          ]) {
            if (!supported) {
              continue;
            }
            const capability = device.capabilitiesObj[capabilityId];
            const min = Math.round((capability?.min ?? 0) * 100);
            const max = Math.round((capability?.max ?? 100) * 100);
            const value =
              typeof capability?.value === 'number' ? Math.round(capability.value * 100) : min;
            setpoints[`occupied${kind}ingSetpoint`] = value;
            setpoints[`min${kind}SetpointLimit`] = min;
            setpoints[`absMin${kind}SetpointLimit`] = min;
            setpoints[`max${kind}SetpointLimit`] = max;
            setpoints[`absMax${kind}SetpointLimit`] = max;
          }

          let controlSequenceOfOperation = Thermostat.ControlSequenceOfOperation.CoolingOnly;
          if (hasHeat && hasCool) {
            controlSequenceOfOperation = Thermostat.ControlSequenceOfOperation.CoolingAndHeating;
          } else if (hasHeat) {
            controlSequenceOfOperation = Thermostat.ControlSequenceOfOperation.HeatingOnly;
          }

          class HomeyThermostatServer extends ThermostatServer.with(...thermostatServerFeatures) {
            async setpointRaiseLower(request) {
              // Matter.js validates/clamps the request in a local actor; forward the result explicitly.
              super.setpointRaiseLower(request);
              const writes = new Map();
              if (hasHeat && request.mode !== Thermostat.SetpointRaiseLowerMode.Cool) {
                writes.set('target_temperature', this.state.occupiedHeatingSetpoint / 100);
              }
              if (hasCool && request.mode !== Thermostat.SetpointRaiseLowerMode.Heat) {
                writes.set(coolingCapability, this.state.occupiedCoolingSetpoint / 100);
              }
              for (const [capabilityId, value] of writes) {
                await device.setCapabilityValue({ capabilityId, value });
              }
            }
          }
          const servers = [HomeyThermostatServer];
          const supportsOnOff = deviceClass === 'airconditioning' && device.capabilitiesObj.onoff;
          if (supportsOnOff) {
            servers.push(
              class extends OnOffServer {
                async on() {
                  await device.setCapabilityValue({ capabilityId: 'onoff', value: true });
                }
                async off() {
                  await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
                }
              },
            );
          }
          const endpoint = new Endpoint(EndpointClass.with(...servers), {
            id: 'main',
            ...(supportsOnOff
              ? { onOff: { onOff: device.capabilitiesObj.onoff.value ?? false } }
              : {}),
            thermostat: {
              ...setpoints,
              systemMode:
                modeValues[device.capabilitiesObj.thermostat_mode?.value] ??
                (hasHeat ? Thermostat.SystemMode.Heat : Thermostat.SystemMode.Cool),
              controlSequenceOfOperation,
              ...(hasAuto ? { minSetpointDeadBand: 0 } : {}),
              localTemperature:
                typeof device.capabilitiesObj.measure_temperature?.value === 'number'
                  ? Math.round(device.capabilitiesObj.measure_temperature.value * 100)
                  : null,
            },
          });
          await registerEndpoint(endpoint);

          if (supportsOnOff) {
            makeCapabilityInstance('onoff', async (value) => {
              await endpoint.set({ onOff: { onOff: value ?? false } });
            });
          }

          // Local reports must never issue a command back to Homey. Only controller writes do.
          for (const [attribute, capabilityId, supported] of [
            ['occupiedHeatingSetpoint', 'target_temperature', hasHeat],
            ['occupiedCoolingSetpoint', coolingCapability, hasCool],
          ]) {
            if (!supported) {
              continue;
            }
            endpoint.events.thermostat.events[`${attribute}$Changing`].on(
              async (value, oldValue, context) => {
                if (context.offline) {
                  return;
                }
                await device.setCapabilityValue({ capabilityId, value: value / 100 });
              },
            );
          }
          endpoint.events.thermostat.events.systemMode$Changing.on(
            async (value, oldValue, context) => {
              if (context.offline) {
                return;
              }
              const mode = Object.keys(modeValues).find((mode) => {
                return modeValues[mode] === value;
              });
              const supported = device.capabilitiesObj.thermostat_mode?.values?.some((entry) => {
                return entry.id === mode;
              });
              if (!supported) {
                throw new Error('Cannot Change Thermostat Mode');
              }
              await device.setCapabilityValue({ capabilityId: 'thermostat_mode', value: mode });
            },
          );

          makeCapabilityInstance('measure_temperature', async (value) => {
            await endpoint.set({
              thermostat: {
                localTemperature: typeof value === 'number' ? Math.round(value * 100) : null,
              },
            });
          });
          makeCapabilityInstance('target_temperature', async (value) => {
            // Matter setpoints are non-nullable; keep the last known setpoint for unknown reports.
            if (typeof value !== 'number') {
              return;
            }
            const thermostat = {};
            if (hasHeat) {
              thermostat.occupiedHeatingSetpoint = Math.round(value * 100);
            }
            if (hasCool && coolingCapability === 'target_temperature') {
              thermostat.occupiedCoolingSetpoint = Math.round(value * 100);
            }
            await endpoint.set({ thermostat });
          });
          if (hasCool && coolingCapability !== 'target_temperature') {
            makeCapabilityInstance(coolingCapability, async (value) => {
              if (typeof value !== 'number') {
                return;
              }
              await endpoint.set({
                thermostat: { occupiedCoolingSetpoint: Math.round(value * 100) },
              });
            });
          }
          makeCapabilityInstance('thermostat_mode', async (value) => {
            if (modeValues[value] === undefined) {
              return;
            }
            await endpoint.set({ thermostat: { systemMode: modeValues[value] } });
          });

          // Humidity
          if (device.capabilitiesObj?.measure_humidity) {
            const endpoint = new Endpoint(
              HumiditySensorDevice.with(RelativeHumidityMeasurementServer),
              {
                id: 'measure_humidity',
                relativeHumidityMeasurement: {
                  measuredValue:
                    typeof device.capabilitiesObj?.measure_humidity?.value === 'number'
                      ? Math.round(device.capabilitiesObj?.measure_humidity?.value * 100)
                      : null,
                },
              },
            );
            await registerEndpoint(endpoint);

            makeCapabilityInstance('measure_humidity', async (value) => {
              await endpoint.set({
                relativeHumidityMeasurement: {
                  measuredValue: typeof value === 'number' ? Math.round(value * 100) : null,
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
                lockState: MatterBridgeServer.#toLockState(device.capabilitiesObj.locked.value),
                actuatorEnabled: true,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('locked', async (value) => {
              await endpoint.set({
                doorLock: {
                  lockState: MatterBridgeServer.#toLockState(value),
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
              async upOrOpen() {
                await device.setCapabilityValue({ capabilityId: 'windowcoverings_set', value: 1 });
              }

              async downOrClose() {
                await device.setCapabilityValue({ capabilityId: 'windowcoverings_set', value: 0 });
              }

              async goToLiftPercentage({ liftPercent100thsValue }) {
                await device.setCapabilityValue({
                  capabilityId: 'windowcoverings_set',
                  value:
                    1 - MatterBridgeServer.#scaleNumber(liftPercent100thsValue, 0, 10000, 0, 1),
                });
              }
            };

            const endpoint = new Endpoint(WindowCoveringDevice.with(HomeyWindowConveringServer), {
              id: 'main',
              windowCovering: {
                targetPositionLiftPercent100ths:
                  typeof device.capabilitiesObj?.windowcoverings_set?.value === 'number'
                    ? 10000 -
                      MatterBridgeServer.#scaleAndRoundNumber(
                        device.capabilitiesObj?.windowcoverings_set?.value,
                        0,
                        1,
                        0,
                        10000,
                      )
                    : null,
                currentPositionLiftPercent100ths:
                  typeof device.capabilitiesObj?.windowcoverings_set?.value === 'number'
                    ? 10000 -
                      MatterBridgeServer.#scaleAndRoundNumber(
                        device.capabilitiesObj?.windowcoverings_set?.value,
                        0,
                        1,
                        0,
                        10000,
                      )
                    : null,
              },
            });
            await registerEndpoint(endpoint);

            makeCapabilityInstance('windowcoverings_set', async (value) => {
              await endpoint.set({
                windowCovering: {
                  currentPositionLiftPercent100ths:
                    typeof value === 'number'
                      ? 10000 - MatterBridgeServer.#scaleAndRoundNumber(value, 0, 1, 0, 10000)
                      : null,
                  targetPositionLiftPercent100ths:
                    typeof value === 'number'
                      ? 10000 - MatterBridgeServer.#scaleAndRoundNumber(value, 0, 1, 0, 10000)
                      : null,
                },
              });
            });
          } else if (device.capabilitiesObj?.windowcoverings_state) {
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
            };

            const movement =
              {
                up: WindowCovering.MovementStatus.Opening,
                down: WindowCovering.MovementStatus.Closing,
                idle: WindowCovering.MovementStatus.Stopped,
              }[device.capabilitiesObj.windowcoverings_state.value] ??
              WindowCovering.MovementStatus.Stopped;
            const endpoint = new Endpoint(WindowCoveringDevice.with(HomeyWindowConveringServer), {
              id: 'main',
              windowCovering: {
                operationalStatus: {
                  global: movement,
                  lift: movement,
                },
              },
            });
            await registerEndpoint(endpoint);

            // Note: The status seems to be synced, but it doesn't show up in Apple Home.
            makeCapabilityInstance('windowcoverings_state', async (value) => {
              switch (value) {
                case 'up': {
                  await endpoint.set({
                    windowCovering: {
                      operationalStatus: {
                        global: WindowCovering.MovementStatus.Opening,
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
                        global: WindowCovering.MovementStatus.Closing,
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
                        global: WindowCovering.MovementStatus.Stopped,
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

        case 'fan': {
          const added = await FanMapping.add({ device, registerEndpoint, makeCapabilityInstance });

          if (added) {
            break;
          }
          // Fans without a known speed control retain the existing on/off fallback.
        }
        default: {
          // If the device has an onoff capability, add it as an OnOffPlugInUnitDevice.
          if (device.capabilitiesObj?.onoff) {
            class HomeyOnOffServer extends OnOffServer {
              async on() {
                await device.setCapabilityValue({
                  capabilityId: 'onoff',
                  value: true,
                });
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

            makeCapabilityInstance('onoff', async (value) => {
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
      if (
        device.capabilitiesObj?.measure_temperature &&
        !this.deviceCapabilityInstances[device.id]?.measure_temperature
      ) {
        const endpoint = new Endpoint(TemperatureSensorDevice.with(TemperatureMeasurementServer), {
          id: 'measure_temperature',
          temperatureMeasurement: {
            measuredValue:
              typeof device.capabilitiesObj?.measure_temperature?.value === 'number'
                ? Math.round(device.capabilitiesObj?.measure_temperature?.value * 100)
                : null,
          },
        });
        await registerEndpoint(endpoint);

        makeCapabilityInstance('measure_temperature', async (value) => {
          await endpoint.set({
            temperatureMeasurement: {
              measuredValue: typeof value === 'number' ? Math.round(value * 100) : null,
            },
          });
        });
      }

      if (
        device.capabilitiesObj?.measure_humidity &&
        !this.deviceCapabilityInstances[device.id]?.measure_humidity
      ) {
        const endpoint = new Endpoint(
          HumiditySensorDevice.with(RelativeHumidityMeasurementServer),
          {
            id: 'measure_humidity',
            relativeHumidityMeasurement: {
              measuredValue:
                typeof device.capabilitiesObj?.measure_humidity?.value === 'number'
                  ? Math.round(device.capabilitiesObj?.measure_humidity?.value * 100)
                  : null,
            },
          },
        );
        await registerEndpoint(endpoint);

        makeCapabilityInstance('measure_humidity', async (value) => {
          await endpoint.set({
            relativeHumidityMeasurement: {
              measuredValue: typeof value === 'number' ? Math.round(value * 100) : null,
            },
          });
        });
      }

      if (
        device.capabilitiesObj?.measure_co &&
        !this.deviceCapabilityInstances[device.id]?.measure_co
      ) {
        const endpoint = new Endpoint(
          AirQualitySensorDevice.with(
            CarbonMonoxideConcentrationMeasurementServer.with('NumericMeasurement'),
          ),
          {
            id: 'measure_co',
            airQuality: { airQuality: AirQuality.AirQualityEnum.Unknown },
            carbonMonoxideConcentrationMeasurement: {
              measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ppm,
              measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
              measuredValue:
                typeof device.capabilitiesObj?.measure_co?.value === 'number'
                  ? device.capabilitiesObj.measure_co.value
                  : null,
            },
          },
        );
        await registerEndpoint(endpoint);

        makeCapabilityInstance('measure_co', async (value) => {
          await endpoint.set({
            carbonMonoxideConcentrationMeasurement: {
              measuredValue: typeof value === 'number' ? value : null,
            },
          });
        });
      }

      if (
        device.capabilitiesObj?.measure_co2 &&
        !this.deviceCapabilityInstances[device.id]?.measure_co2
      ) {
        const endpoint = new Endpoint(
          AirQualitySensorDevice.with(
            CarbonDioxideConcentrationMeasurementServer.with('NumericMeasurement'),
          ),
          {
            id: 'measure_co2',
            airQuality: { airQuality: AirQuality.AirQualityEnum.Unknown },
            carbonDioxideConcentrationMeasurement: {
              measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ppm,
              measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
              measuredValue:
                typeof device.capabilitiesObj?.measure_co2?.value === 'number'
                  ? device.capabilitiesObj.measure_co2.value
                  : null,
            },
          },
        );
        await registerEndpoint(endpoint);

        makeCapabilityInstance('measure_co2', async (value) => {
          await endpoint.set({
            carbonDioxideConcentrationMeasurement: {
              measuredValue: typeof value === 'number' ? value : null,
            },
          });
        });
      }

      if (
        device.capabilitiesObj?.measure_pm10 &&
        !this.deviceCapabilityInstances[device.id]?.measure_pm10
      ) {
        const endpoint = new Endpoint(
          AirQualitySensorDevice.with(
            Pm10ConcentrationMeasurementServer.with('NumericMeasurement'),
          ),
          {
            id: 'measure_pm10',
            airQuality: { airQuality: AirQuality.AirQualityEnum.Unknown },
            pm10ConcentrationMeasurement: {
              measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ugm3,
              measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
              measuredValue:
                typeof device.capabilitiesObj?.measure_pm10?.value === 'number'
                  ? device.capabilitiesObj.measure_pm10.value
                  : null,
            },
          },
        );
        await registerEndpoint(endpoint);

        makeCapabilityInstance('measure_pm10', async (value) => {
          await endpoint.set({
            pm10ConcentrationMeasurement: {
              measuredValue: typeof value === 'number' ? value : null,
            },
          });
        });
      }

      if (
        device.capabilitiesObj?.measure_pm25 &&
        !this.deviceCapabilityInstances[device.id]?.measure_pm25
      ) {
        const endpoint = new Endpoint(
          AirQualitySensorDevice.with(
            Pm25ConcentrationMeasurementServer.with('NumericMeasurement'),
          ),
          {
            id: 'measure_pm25',
            airQuality: { airQuality: AirQuality.AirQualityEnum.Unknown },
            pm25ConcentrationMeasurement: {
              measurementUnit: ConcentrationMeasurement.MeasurementUnit.Ugm3,
              measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
              measuredValue:
                typeof device.capabilitiesObj?.measure_pm25?.value === 'number'
                  ? device.capabilitiesObj.measure_pm25.value
                  : null,
            },
          },
        );
        await registerEndpoint(endpoint);

        makeCapabilityInstance('measure_pm25', async (value) => {
          await endpoint.set({
            pm25ConcentrationMeasurement: {
              measuredValue: typeof value === 'number' ? value : null,
            },
          });
        });
      }

      if (
        device.capabilitiesObj?.measure_luminance &&
        !this.deviceCapabilityInstances[device.id]?.measure_luminance
      ) {
        const endpoint = new Endpoint(LightSensorDevice, {
          id: 'measure_luminance',
          illuminanceMeasurement: {
            measuredValue: MatterBridgeServer.#toIlluminance(
              device.capabilitiesObj.measure_luminance.value,
            ),
          },
        });
        await registerEndpoint(endpoint);

        makeCapabilityInstance('measure_luminance', async (value) => {
          await endpoint.set({
            illuminanceMeasurement: {
              measuredValue: MatterBridgeServer.#toIlluminance(value),
            },
          });
        });
      }

      if (
        device.capabilitiesObj?.alarm_motion &&
        !this.deviceCapabilityInstances[device.id]?.alarm_motion
      ) {
        const endpoint = new Endpoint(
          OccupancySensorDevice.with(
            OccupancySensingServer.with(OccupancySensing.Feature.PassiveInfrared),
          ),
          {
            id: 'alarm_motion',
            occupancySensing: {
              occupancy: {
                occupied: device.capabilitiesObj?.alarm_motion?.value === true,
              },
            },
          },
        );
        await registerEndpoint(endpoint);

        makeCapabilityInstance('alarm_motion', async (value) => {
          await endpoint.set({
            occupancySensing: {
              occupancy: {
                occupied: value === true,
              },
            },
          });
        });
      }

      if (
        device.capabilitiesObj?.alarm_occupancy &&
        !this.deviceCapabilityInstances[device.id]?.alarm_occupancy
      ) {
        const endpoint = new Endpoint(
          OccupancySensorDevice.with(
            OccupancySensingServer.with(OccupancySensing.Feature.Ultrasonic),
          ),
          {
            id: 'alarm_occupancy',
            occupancySensing: {
              occupancySensorType: OccupancySensing.OccupancySensorType.Ultrasonic,
              occupancy: {
                occupied: device.capabilitiesObj?.alarm_occupancy?.value === true,
              },
            },
          },
        );
        await registerEndpoint(endpoint);

        makeCapabilityInstance('alarm_occupancy', async (value) => {
          await endpoint.set({
            occupancySensing: {
              occupancy: {
                occupied: value === true,
              },
            },
          });
        });
      }

      if (
        device.capabilitiesObj?.alarm_contact &&
        !this.deviceCapabilityInstances[device.id]?.alarm_contact
      ) {
        // TODO: See this working in Apple Home
        const endpoint = new Endpoint(ContactSensorDevice.with(BooleanStateServer), {
          id: 'alarm_contact',
          booleanState: {
            stateValue: device.capabilitiesObj?.alarm_contact?.value === false,
          },
        });
        await registerEndpoint(endpoint);

        makeCapabilityInstance('alarm_contact', async (value) => {
          await endpoint.set({
            booleanState: {
              stateValue: value === false,
            },
          });
        });
      }

      if (
        device.capabilitiesObj?.alarm_water &&
        !this.deviceCapabilityInstances[device.id]?.alarm_water
      ) {
        const endpoint = new Endpoint(WaterLeakDetectorDevice, {
          id: 'alarm_water',
          booleanState: { stateValue: device.capabilitiesObj.alarm_water.value === true },
        });
        await registerEndpoint(endpoint);

        makeCapabilityInstance('alarm_water', async (value) => {
          await endpoint.set({ booleanState: { stateValue: value } });
        });
      }

      if (
        device.capabilitiesObj?.alarm_smoke &&
        !this.deviceCapabilityInstances[device.id]?.alarm_smoke
      ) {
        const endpoint = new Endpoint(
          SmokeCoAlarmDevice.with(SmokeCoAlarmServer.with('SmokeAlarm')),
          {
            id: 'alarm_smoke',
            smokeCoAlarm: {
              expressedState:
                device.capabilitiesObj.alarm_smoke.value === true
                  ? SmokeCoAlarm.ExpressedState.SmokeAlarm
                  : SmokeCoAlarm.ExpressedState.Normal,
              smokeState:
                device.capabilitiesObj?.alarm_smoke?.value === true
                  ? SmokeCoAlarm.AlarmState.Critical
                  : SmokeCoAlarm.AlarmState.Normal,
            },
          },
        );
        await registerEndpoint(endpoint);

        makeCapabilityInstance('alarm_smoke', async (value) => {
          await endpoint.set({
            smokeCoAlarm: {
              expressedState:
                value === true
                  ? SmokeCoAlarm.ExpressedState.SmokeAlarm
                  : SmokeCoAlarm.ExpressedState.Normal,
              smokeState:
                value === true ? SmokeCoAlarm.AlarmState.Critical : SmokeCoAlarm.AlarmState.Normal,
            },
          });
        });
      }

      await PowerTelemetry.add({
        device,
        parent: deviceEndpoint,
        registerEndpoint,
        makeCapabilityInstance,
        subscriptions: this.deviceCapabilityInstances[device.id],
      });

      // Matter restores persisted attributes while endpoints initialize. Refresh from the source
      // only after every endpoint exists, using the same conversions as subscription updates.
      for (const update of initialUpdates) {
        await update();
      }

      initializing = false;
      await this.#updateDeviceReachability(device);
    });
  }

  async #updateDeviceReachability(device) {
    const endpoint = this.deviceEndpoints[device.id];

    if (!endpoint) {
      return;
    }

    const initialized = this.deviceEndpointInstances[device.id] !== undefined;
    const available = device.available !== false && device.ready === true;
    const subscriptions = this.deviceCapabilityInstances[device.id] ?? {};
    const unknownReading = MatterBridgeServer.#capabilitiesRequiringKnownBoolean.some((id) => {
      return subscriptions[id] && typeof device.capabilitiesObj[id]?.value !== 'boolean';
    });
    const deviceClass = device.virtualClass || device.class;
    const speed = deviceClass === 'fan' ? FanMapping.speedCapability(device.capabilitiesObj) : null;
    const unknownSpeed = speed && subscriptions[speed.id] &&
      !Number.isFinite(device.capabilitiesObj[speed.id].value);
    const reachable = initialized && available && !unknownReading && !unknownSpeed;

    if (endpoint.state.bridgedDeviceBasicInformation.reachable !== reachable) {
      await endpoint.set({ bridgedDeviceBasicInformation: { reachable } });
    }
  }

  async __uninitEndpoint(device) {
    return await this.__queue.add(async () => {
      this.debug(`Uninitializing Endpoint for ${device.name} (${device.id})`);

      const deviceEndpoint = this.deviceEndpoints[device.id];
      if (!deviceEndpoint) {
        return;
      }

      for (const instance of Object.values(this.deviceCapabilityInstances[device.id] ?? {})) {
        await instance.destroy();
      }
      delete this.deviceCapabilityInstances[device.id];
      await deviceEndpoint.delete();
      delete this.deviceEndpoints[device.id];

      delete this.deviceEndpointInstances[device.id];
    });
  }

  pauseQueue() {
    this.__queue.pause();
  }

  resumeQueue() {
    this.__queue.start();
  }

  static async #setSupportedCapabilities(device, values) {
    const writePromises = [];

    for (const [capabilityId, value] of Object.entries(values)) {
      if (!device.capabilitiesObj[capabilityId]) {
        continue;
      }

      writePromises.push(device.setCapabilityValue({ capabilityId, value }));
    }

    await Promise.all(writePromises);
  }

  static #toLockState(value) {
    if (typeof value !== 'boolean') {
      return null;
    }
    return value ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked;
  }

  static #toIlluminance(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return null;
    }
    if (value === 0) {
      return 0;
    }
    return Math.min(65534, Math.max(1, Math.round(10000 * Math.log10(value) + 1)));
  }

  static #scaleNumber(value, minInput, maxInput, minOutput, maxOutput) {
    const scaledValue =
      ((value - minInput) / (maxInput - minInput)) * (maxOutput - minOutput) + minOutput;
    return Math.min(Math.max(scaledValue, minOutput), maxOutput);
  }

  static #scaleAndRoundNumber(...props) {
    return Math.round(MatterBridgeServer.#scaleNumber(...props));
  }

  static #ellipsizeString(value, maxLength = 32) {
    if (typeof value !== 'string') {
      return null;
    }
    if (value.length > maxLength) {
      return value.substring(0, maxLength - 3) + '…';
    }
    return value;
  }
}
