import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { CommandChecks } from './mappings/CommandChecks.mjs';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { mappings } from './mappings/manifest.mjs';
import { selectMappings } from './mappings/selectMappings.mjs';
import { upgradeVectors } from './mappings/upgradeVectors.mjs';

test(
  'every mapping restores current Homey state with an existing pairing',
  { timeout: 180000 },
  async (t) => {
    const selected = selectMappings(mappings, process.env.MAPPING_CASE);
    const harness = await BridgeHarness.create(selected);
    t.after(async () => {
      await harness.close();
    });
    const identities = new Map();
    for (const fixture of selected) {
      for (const endpoint of fixture.endpoints) {
        identities.set(`${fixture.id}/${endpoint.id}`, harness.endpoint(fixture.id, endpoint.id));
      }
    }

    // Exercise state changes before stopping: constructor defaults alone need not be persisted.
    for (const fixture of selected) {
      const device = harness.devices[fixture.id];
      const vectors = upgradeVectors(fixture);
      for (const [id, value] of Object.entries(vectors.values)) {
        device.emit(id, value);
      }
      for (const attribute of vectors.attributes) {
        await harness.expectReport(
          harness.endpoint(fixture.id, attribute.endpoint),
          attribute.cluster,
          attribute.name,
          attribute.expected,
        );
      }
      for (const [id, capability] of Object.entries(fixture.capabilities)) {
        device.emit(id, capability.value);
      }
      for (const attribute of fixture.attributes) {
        await harness.expectReport(
          harness.endpoint(fixture.id, attribute.endpoint),
          attribute.cluster,
          attribute.name,
          attribute.initial,
        );
      }
    }

    await harness.restart(() => {
      for (const fixture of selected) {
        const device = harness.devices[fixture.id];
        for (const listeners of device.listeners.values()) {
          assert.equal(listeners.size, 0, 'Subscriptions must be released while stopped');
        }
        for (const [id, value] of Object.entries(upgradeVectors(fixture).values)) {
          device.emit(id, value);
        }
      }
    });

    for (const fixture of selected) {
      await t.test(fixture.id, async () => {
        for (const endpoint of fixture.endpoints) {
          assert.equal(
            harness.endpoint(fixture.id, endpoint.id),
            identities.get(`${fixture.id}/${endpoint.id}`),
          );
        }
        for (const attribute of upgradeVectors(fixture).attributes) {
          const endpoint = harness.endpoint(fixture.id, attribute.endpoint);
          assert.deepEqual(
            await harness.read(endpoint, attribute.cluster, attribute.name),
            attribute.expected,
            `${fixture.id}/${attribute.cluster}.${attribute.name} after offline source change`,
          );
          await harness.expectReport(
            endpoint,
            attribute.cluster,
            attribute.name,
            attribute.expected,
          );
        }
        assert.equal(
          harness.devices[fixture.id].writes.length,
          0,
          'Startup must not command Homey',
        );
      });
    }
  },
);

test(
  'previous release storage upgrades every mapping without pairing again',
  { timeout: 600000 },
  async (t) => {
    const storageFixture = JSON.parse(
      await readFile(new URL('./fixtures/mapping-upgrade.json', import.meta.url), 'utf8'),
    );
    const selected = selectMappings(mappings, process.env.MAPPING_CASE);
    const changed = selected.map((fixture) => {
      const result = structuredClone(fixture);
      for (const [id, value] of Object.entries(upgradeVectors(fixture).values)) {
        result.capabilities[id].value = value;
      }
      return result;
    });
    const harness = await BridgeHarness.create(changed, { storageFixture });
    t.after(async () => {
      await harness.close();
    });
    assert.equal(harness.bridge.serverNode.lifecycle.isCommissioned, true);

    for (const fixture of selected) {
      await t.test(fixture.id, async () => {
        // New device types initialize alongside the saved endpoints of existing mappings.
        for (const endpoint of storageFixture.endpoints[fixture.id] ?? []) {
          assert.equal(
            harness.endpoint(fixture.id, endpoint.id),
            endpoint.number,
            'Existing endpoint identity',
          );
        }
        for (const attribute of upgradeVectors(fixture).attributes) {
          const endpoint = harness.endpoint(fixture.id, attribute.endpoint);
          assert.deepEqual(
            await harness.read(endpoint, attribute.cluster, attribute.name),
            attribute.expected,
            `${fixture.id}/${attribute.name}: previous-release upgrade`,
          );
          await harness.expectReport(
            endpoint,
            attribute.cluster,
            attribute.name,
            attribute.expected,
          );
        }
        const device = harness.devices[fixture.id];
        assert.equal(device.writes.length, 0, 'Upgrade must not write source capabilities');
        for (const [id, capability] of Object.entries(fixture.capabilities)) {
          device.emit(id, capability.value);
        }
        for (const attribute of fixture.attributes) {
          await harness.expectReport(
            harness.endpoint(fixture.id, attribute.endpoint),
            attribute.cluster,
            attribute.name,
            attribute.initial,
          );
        }
        const commands = new CommandChecks(harness, fixture);
        for (const command of [...fixture.commands, ...(fixture.writes ?? [])]) {
          await commands.run(command);
        }
      });
    }
  },
);
