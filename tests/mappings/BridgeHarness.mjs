import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControllerBehavior, Environment, Logger, ServerNode } from '@matter/main';
import { Invoke, Read, Write, Subscribe } from '@matter/main/protocol';
import { Identify } from '@matter/main/clusters/identify';
import { Groups } from '@matter/main/clusters/groups';
import { Descriptor } from '@matter/main/clusters/descriptor';
import { ScenesManagement } from '@matter/main/clusters/scenes-management';
import { AirQuality } from '@matter/main/clusters/air-quality';
import { OnOff } from '@matter/main/clusters/on-off';
import { LevelControl } from '@matter/main/clusters/level-control';
import { ColorControl } from '@matter/main/clusters/color-control';
import { Thermostat } from '@matter/main/clusters/thermostat';
import { DoorLock } from '@matter/main/clusters/door-lock';
import { WindowCovering } from '@matter/main/clusters/window-covering';
import { ElectricalPowerMeasurement } from '@matter/main/clusters/electrical-power-measurement';
import { TemperatureMeasurement } from '@matter/main/clusters/temperature-measurement';
import { RelativeHumidityMeasurement } from '@matter/main/clusters/relative-humidity-measurement';
import { CarbonMonoxideConcentrationMeasurement } from '@matter/main/clusters/carbon-monoxide-concentration-measurement';
import { CarbonDioxideConcentrationMeasurement } from '@matter/main/clusters/carbon-dioxide-concentration-measurement';
import { Pm10ConcentrationMeasurement } from '@matter/main/clusters/pm10-concentration-measurement';
import { Pm25ConcentrationMeasurement } from '@matter/main/clusters/pm25-concentration-measurement';
import { IlluminanceMeasurement } from '@matter/main/clusters/illuminance-measurement';
import { BooleanState } from '@matter/main/clusters/boolean-state';
import { OccupancySensing } from '@matter/main/clusters/occupancy-sensing';
import { SmokeCoAlarm } from '@matter/main/clusters/smoke-co-alarm';
import { MatterBridgeServer } from '../../lib/MatterBridgeServer.mjs';

import { eventually } from './eventually.mjs';
import { SimulatedDevice } from './SimulatedDevice.mjs';

Logger.level = 'fatal';

export class BridgeHarness {
  static #clusters = {
    Identify,
    Groups,
    Descriptor,
    ScenesManagement,
    AirQuality,
    OnOff,
    LevelControl,
    ColorControl,
    Thermostat,
    DoorLock,
    WindowCovering,
    ElectricalPowerMeasurement,
    TemperatureMeasurement,
    RelativeHumidityMeasurement,
    CarbonMonoxideConcentrationMeasurement,
    CarbonDioxideConcentrationMeasurement,
    Pm10ConcentrationMeasurement,
    Pm25ConcentrationMeasurement,
    IlluminanceMeasurement,
    BooleanState,
    OccupancySensing,
    SmokeCoAlarm,
  };

  static async create(fixtures) {
    const harness = new BridgeHarness();
    harness.directory = await mkdtemp(join(tmpdir(), 'bridge-mappings-'));
    harness.devices = Object.fromEntries(
      fixtures.map((fixture) => {
        return [fixture.id, new SimulatedDevice(fixture)];
      }),
    );
    harness.manager = new EventEmitter();
    harness.manager.connect = async () => {};
    harness.manager.getDevices = async () => {
      return harness.devices;
    };
    harness.manager.getDevice = async ({ id }) => {
      return harness.devices[id];
    };
    harness.errors = [];
    harness.reports = new Map();
    const discriminator = randomInt(1, 4096);
    harness.options = {
      api: {
        devices: harness.manager,
        drivers: {
          connect: async () => {},
          getDrivers: async () => {
            return {};
          },
        },
      },
      debug: (...messages) => {
        if (String(messages[0]).startsWith('Error')) {
          harness.errors.push(messages.join(' '));
        }
      },
      deviceName: 'Mapping bridge',
      vendorName: 'Test',
      vendorId: 65521,
      productName: 'Mapping bridge',
      productId: 32768,
      uniqueId: 'mapping-bridge',
      serialNumber: 'mapping-test',
      passcode: 20202021,
      discriminator,
      port: 0,
      storageServiceLocation: harness.directory,
      enabledDeviceIds: new Set(Object.keys(harness.devices)),
    };

    try {
      harness.bridge = new MatterBridgeServer(harness.options);
      await harness.bridge.start();

      const environment = new Environment('mapping-controller', Environment.default);
      environment.vars.set('storage.path', harness.directory);
      harness.controller = await ServerNode.create(
        ServerNode.RootEndpoint.with(ControllerBehavior),
        {
          id: 'mapping-controller',
          environment,
          network: { port: 0 },
          controller: { adminFabricLabel: 'Mapping tests' },
        },
      );

      harness.peer = await harness.controller.peers.commission({
        passcode: 20202021,
        longDiscriminator: discriminator,
        timeout: 10000,
        onAttestationFailure: true,
      });
      await harness.peer.start();
      harness.subscription = await harness.peer.interaction.subscribe({
        ...Subscribe({ attributes: [{}], minIntervalFloor: 0, maxIntervalCeiling: 60 }),
        updated: async (chunks) => {
          for await (const chunk of chunks) {
            for (const report of chunk) {
              if (report.kind !== 'attr-value') {
                continue;
              }

              harness.reports.set(BridgeHarness.key(report.path), report.value);
              await harness.onReport?.(report);
            }
          }
        },
      });
      const initialReports = await harness.readRaw();

      for (const report of initialReports) {
        if (report.kind !== 'attr-value') {
          continue;
        }

        const key = BridgeHarness.key(report.path);
        if (!harness.reports.has(key)) {
          harness.reports.set(key, report.value);
        }
      }
      return harness;
    } catch (error) {
      try {
        await harness.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Mapping setup and cleanup failed');
      }
      throw error;
    }
  }

  static key(path) {
    return `${path.endpointId}.${path.clusterId}.${path.attributeId}`;
  }

  endpoint(deviceId, id = 'main') {
    const endpoint = [...(this.bridge.deviceEndpointInstances[deviceId] ?? [])].find((item) => {
      return item.id === id;
    });
    assert.ok(endpoint, `${deviceId}/${id} exists: ${this.errors.join('; ')}`);
    return endpoint.number;
  }

  static cluster(name) {
    const cluster = BridgeHarness.#clusters[name];
    assert.ok(cluster, `Unknown Matter cluster: ${name}`);
    return cluster;
  }

  async readRaw(paths = [{}]) {
    const result = [];

    for await (const chunk of this.peer.interaction.read({
      ...Read({ attributes: paths }),
      includeKnownVersions: true,
    })) {
      result.push(...chunk);
    }

    return result;
  }

  async read(endpointId, clusterName, attributeName) {
    const path = BridgeHarness.#attributePath(endpointId, clusterName, attributeName);
    const reports = await this.readRaw([path]);
    const report = reports.find((item) => {
      return item.kind === 'attr-value';
    });
    assert.ok(
      report,
      `Missing ${endpointId}/${clusterName}/${attributeName}: ${JSON.stringify(reports)}`,
    );
    return report.value;
  }

  async expectReport(endpointId, clusterName, attributeName, expected) {
    const path = BridgeHarness.#attributePath(endpointId, clusterName, attributeName);
    const key = BridgeHarness.key(path);

    await eventually(
      () => {
        const value = this.reports.get(key);
        assert.ok(
          this.reports.has(key),
          `No subscription report for ${clusterName}.${attributeName}`,
        );
        assert.deepEqual(value, expected);
      },
      `Subscription ${endpointId}/${clusterName}/${attributeName} did not become ${JSON.stringify(expected)}`,
    );
  }

  static #attributePath(endpointId, clusterName, attributeName) {
    const cluster = BridgeHarness.cluster(clusterName);
    const globalAttributes = {
      featureMap: 65532,
      attributeList: 65531,
      acceptedCommandList: 65529,
    };
    const attributeId = cluster.attributes[attributeName]?.id ?? globalAttributes[attributeName];

    assert.notEqual(
      attributeId,
      undefined,
      `Unknown Matter attribute: ${clusterName}.${attributeName}`,
    );

    return { endpointId, clusterId: cluster.id, attributeId };
  }

  async invoke(endpoint, cluster, command, fields) {
    if (fields && Object.keys(fields).length === 0) {
      fields = undefined;
    }
    const responses = [];
    for await (const chunk of this.peer.interaction.invoke(
      Invoke({
        commands: [{ endpoint, cluster: BridgeHarness.cluster(cluster).Cluster, command, fields }],
      }),
    )) {
      responses.push(...chunk);
      for (const response of chunk) {
        if (response.kind === 'cmd-status' && response.status !== 0) {
          throw new Error(`Command failed: ${response.status}`);
        }
      }
    }
    return responses;
  }

  async write(endpoint, cluster, attribute, value) {
    const result = await this.peer.interaction.write(
      Write(
        Write.Attribute({
          endpoint,
          cluster: BridgeHarness.cluster(cluster).Cluster,
          attributes: attribute,
          value,
        }),
      ),
    );
    for (const response of result) {
      if (response.status !== 0) {
        throw new Error(`Write failed: ${response.status}`);
      }
    }
  }

  async close() {
    const errors = [];
    const cleanupSteps = [
      () => {
        return this.subscription?.close();
      },
      () => {
        return this.controller?.peers.close();
      },
      () => {
        return this.controller?.close();
      },
      () => {
        return this.bridge?.stop();
      },
      () => {
        return Environment.default.runtime.close();
      },
    ];

    if (this.directory) {
      cleanupSteps.push(() => {
        return rm(this.directory, { recursive: true, force: true });
      });
    }

    // A failed cleanup step must not strand the remaining controller, bridge, or temporary state.
    for (const cleanup of cleanupSteps) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length) {
      throw new AggregateError(errors, 'Mapping harness cleanup failed');
    }
  }
}
