import { SimulatedDevice } from './mappings/SimulatedDevice.mjs';
import { MatterBridgeServer } from '../lib/MatterBridgeServer.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerSet } from '@matter/main/protocol';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { eventually } from './mappings/eventually.mjs';
import { mappings } from './mappings/manifest.mjs';
import { selectMappings } from './mappings/selectMappings.mjs';

test('bridge mapping contracts through a Matter controller', { timeout: 180000 }, async (t) => {
  const selected = selectMappings(mappings, process.env.MAPPING_CASE);
  const harness = await BridgeHarness.create(selected);
  t.after(async () => {
    await harness.close();
  });
  for (const fixture of selected) {
    await t.test(fixture.id, async (t) => {
      const device = harness.devices[fixture.id];
      await t.test('discovery and initial values', async () => {
        const children = [...(harness.bridge.deviceEndpointInstances[fixture.id] ?? [])];
        assert.deepEqual(
          children
            .map((endpoint) => {
              return endpoint.id;
            })
            .sort(),
          fixture.endpoints
            .map((endpoint) => {
              return endpoint.id;
            })
            .sort(),
        );
        for (const expected of fixture.endpoints) {
          const number = harness.endpoint(fixture.id, expected.id);
          assert.deepEqual(
            (await harness.read(number, 'Descriptor', 'serverList')).sort((a, b) => {
              return a - b;
            }),
            expected.clusters,
            'Advertised clusters',
          );
          const types = await harness.read(number, 'Descriptor', 'deviceTypeList');
          assert.deepEqual(
            types.map((type) => {
              return type.deviceType;
            }),
            [expected.type],
            `${fixture.id}/${expected.id} device types`,
          );
          for (const [cluster, features] of Object.entries(expected.features ?? {})) {
            const actual = await harness.read(number, cluster, 'featureMap');
            const enabled = (value) => {
              return Object.keys(value)
                .filter((key) => {
                  return value[key] === true;
                })
                .sort();
            };
            assert.deepEqual(enabled(actual), enabled(features), `${cluster} advertised features`);
          }
          for (const [cluster, attributes] of Object.entries(expected.values ?? {})) {
            for (const [name, value] of Object.entries(attributes)) {
              assert.deepEqual(
                await harness.read(number, cluster, name),
                value,
                `${cluster}.${name}`,
              );
            }
          }
        }
        for (const expected of fixture.attributes) {
          const actual = await harness.read(
            harness.endpoint(fixture.id, expected.endpoint),
            expected.cluster,
            expected.name,
          );
          assert.deepEqual(
            actual,
            expected.initial,
            `${fixture.id}/${expected.capabilityId} initial`,
          );
        }
        for (const operation of fixture.commands) {
          const accepted = await harness.read(
            harness.endpoint(fixture.id, operation.endpoint),
            operation.cluster,
            'acceptedCommandList',
          );
          assert.ok(
            accepted.includes(BridgeHarness.cluster(operation.cluster).commands[operation.name].id),
            `Command ${operation.name} must be advertised`,
          );
        }
      });
      const setpoint = fixture.attributes.find((item) => {
        return item.cluster === 'Thermostat' && item.name.includes('Setpoint');
      });
      if (setpoint) {
        await t.test('thermostat limits and unknown targets', async () => {
          const endpoint = harness.endpoint(fixture.id, setpoint.endpoint);
          const lastValue = await harness.read(endpoint, 'Thermostat', setpoint.name);
          const attempts = device.attempts;
          device.emit(setpoint.capabilityId, null);
          assert.equal(await harness.read(endpoint, 'Thermostat', setpoint.name), lastValue);
          await assert.rejects(harness.write(endpoint, 'Thermostat', setpoint.name, 3100));
          await assert.rejects(harness.write(endpoint, 'Thermostat', setpoint.name, 1500));
          assert.equal(
            device.attempts,
            attempts,
            'Invalid writes and source reports must not command Homey',
          );
        });
      }
      await t.test('Homey updates reach subscriptions', async () => {
        const attempts = device.attempts;
        for (const expected of fixture.attributes) {
          const endpoint = harness.endpoint(fixture.id, expected.endpoint);
          for (const [input, output] of expected.updates) {
            device.emit(expected.capabilityId, input);
            await harness.expectReport(endpoint, expected.cluster, expected.name, output);
          }
        }
        assert.equal(
          device.attempts,
          attempts,
          'Source reports must not echo commands back to Homey',
        );
      });
      await t.test('controller commands and writes reach Homey', async () => {
        for (const operation of [...fixture.commands, ...(fixture.writes ?? [])]) {
          for (const [id, value] of Object.entries(operation.prepare ?? {})) {
            device.emit(id, value);
            const check = fixture.attributes.find((item) => {
              return item.capabilityId === id;
            });
            await harness.expectReport(
              harness.endpoint(fixture.id, check.endpoint),
              check.cluster,
              check.name,
              check.initial,
            );
          }
          device.writes.length = 0;
          const endpoint = harness.endpoint(fixture.id, operation.endpoint);
          if (operation.attribute) {
            await harness.write(endpoint, operation.cluster, operation.attribute, operation.value);
          } else {
            await harness.invoke(endpoint, operation.cluster, operation.name, operation.fields);
          }
          await eventually(
            () => {
              const actual = Object.fromEntries(
                device.writes.map((write) => {
                  return [write.capabilityId, write.value];
                }),
              );
              assert.deepEqual(actual, operation.writes);
            },
            `${fixture.id} did not execute ${operation.name ?? operation.attribute}`,
          );
        }
      });
      const operation = fixture.commands[0] ?? fixture.writes?.[0];
      if (operation) {
        await t.test('Homey rejections are reported', async () => {
          if (operation.attribute) {
            const expected = fixture.attributes.find((item) => {
              return item.name === operation.attribute;
            });
            device.emit(expected.capabilityId, fixture.capabilities[expected.capabilityId].value);
            await harness.expectReport(
              harness.endpoint(fixture.id, expected.endpoint),
              expected.cluster,
              expected.name,
              expected.initial,
            );
          }
          const attempts = device.attempts;
          device.rejectWrites = true;
          try {
            const endpoint = harness.endpoint(fixture.id, operation.endpoint);
            if (operation.attribute) {
              await assert.rejects(
                harness.write(endpoint, operation.cluster, operation.attribute, operation.value),
              );
            } else {
              await assert.rejects(
                harness.invoke(endpoint, operation.cluster, operation.name, operation.fields),
              );
            }
            assert.ok(
              device.attempts > attempts,
              'Rejection came from Homey, not local request validation',
            );
          } finally {
            device.rejectWrites = false;
          }
        });
      }
    });
  }
  await t.test('disable/re-enable releases subscriptions and restores reports', async () => {
    const fixture = selected.find((item) => {
      return item.id === 'socket';
    });
    if (!fixture) {
      return;
    }
    const device = harness.devices.socket;
    await harness.bridge.disableDevice(device.id);
    for (const listeners of device.listeners.values()) {
      assert.equal(listeners.size, 0);
    }
    await harness.bridge.enableDevice(device.id);
    const endpoint = harness.endpoint(device.id);
    device.emit('onoff', false);
    await harness.expectReport(endpoint, 'OnOff', 'onOff', false);
    device.emit('onoff', true);
    await harness.expectReport(endpoint, 'OnOff', 'onOff', true);
    assert.equal(device.listeners.get('onoff').size, 1);
  });

  await t.test('delayed readiness and restart preserve identity and control', async () => {
    if (!harness.devices.socket) {
      return;
    }
    const fixture = structuredClone(
      selected.find((item) => {
        return item.id === 'socket';
      }),
    );
    fixture.id = 'delayed-socket';
    fixture.ready = false;
    const delayed = new SimulatedDevice(fixture);
    harness.devices[delayed.id] = delayed;
    await harness.bridge.enableDevice(delayed.id);
    assert.equal(harness.bridge.deviceEndpointInstances[delayed.id], undefined);
    delayed.ready = true;
    harness.manager.emit('device.update', delayed);
    await eventually(() => {
      assert.ok(harness.endpoint(delayed.id));
    }, 'Delayed device initialization');
    const endpoint = harness.endpoint(delayed.id);
    assert.equal(await harness.read(endpoint, 'OnOff', 'onOff'), true);
    const numbers = Object.fromEntries(
      Object.keys(harness.devices).map((id) => {
        return [id, harness.bridge.deviceEndpoints[id].number];
      }),
    );
    const childNumbers = [];
    for (const [deviceId, endpoints] of Object.entries(harness.bridge.deviceEndpointInstances)) {
      for (const child of endpoints) {
        childNumbers.push({ deviceId, id: child.id, number: child.number });
      }
    }
    const port = harness.bridge.serverNode.state.network.operationalPort;
    await harness.subscription.close();
    harness.subscription = undefined;
    await harness.controller.env
      .get(PeerSet)
      .for(harness.peer.state.commissioning.peerAddress)
      .disconnect(new Error('Bridge restart test'));
    await harness.peer.cancel();
    await harness.bridge.stop();
    assert.equal(harness.manager.listenerCount('device.update'), 0);
    for (const device of Object.values(harness.devices)) {
      for (const listeners of device.listeners.values()) {
        assert.equal(listeners.size, 0);
      }
    }
    harness.bridge = new MatterBridgeServer({ ...harness.options, port });
    await harness.bridge.start();
    for (const [id, number] of Object.entries(numbers)) {
      assert.equal(harness.bridge.deviceEndpoints[id].number, number);
    }
    for (const child of childNumbers) {
      assert.equal(harness.endpoint(child.deviceId, child.id), child.number);
    }
    assert.equal(harness.endpoint(delayed.id), endpoint);
    await harness.peer.start();
    await harness.invoke(endpoint, 'OnOff', 'off');
    await eventually(() => {
      assert.equal(delayed.capabilitiesObj.onoff.value, false);
    }, 'Existing controller controls after restart');
    assert.equal(await harness.read(endpoint, 'OnOff', 'onOff'), false);
  });
});
