import assert from 'node:assert/strict';
import test from 'node:test';
import profiles from '../fixtures/homey-app/profiles.json' with { type: 'json' };
import { FIXTURE_APP_ID } from '../../scripts/integration/config.mjs';
import { createBridge } from './support/bridge.mjs';

// This contract test runs through the installed Homey SDK and device APIs.
// It establishes simulator behavior independently of Matter mapping correctness.
test('fixture drivers implement reports, commands, limits and failure controls', { timeout: 120000 }, async (t) => {
  const { homey, byType } = await createBridge(t, { types: Object.keys(profiles), commission: false });

  for (const [type, profile] of Object.entries(profiles)) {
    await t.test(type, async () => {
      const device = byType[type];
      assert.equal(device.driverId, `homey:app:${FIXTURE_APP_ID}:${type}`);
      assert.equal(device.class, profile.class);
      assert.deepEqual([...device.capabilities].sort(), Object.keys(profile.values).sort());
      assert.deepEqual((await homey.fixture(device)).values, profile.values);

      for (const [capability, value] of Object.entries(profile.commands)) {
        const before = await homey.value(device.id, capability);
        await homey.reject(device, capability, true);
        await assert.rejects(homey.set(device.id, capability, value));
        assert.equal(await homey.value(device.id, capability), before, 'Rejected commands preserve backend state');
        assert.deepEqual((await homey.fixture(device)).commands.at(-1), { capability, value, accepted: false });
        await homey.reject(device, capability, false);
        await homey.set(device.id, capability, value);
        assert.equal(await homey.value(device.id, capability), value);
        assert.deepEqual((await homey.fixture(device)).commands.at(-1), { capability, value, accepted: true });
      }

      for (const [capability, initial] of Object.entries(profile.values)) {
        if (profile.commands[capability] !== undefined) {
          continue;
        }

        const value = typeof initial === 'boolean' ? !initial : initial + 1;
        await homey.report(device, { [capability]: value });
        assert.equal(await homey.value(device.id, capability), value, 'Read-only reports reach Homey through the SDK');
      }

      for (const [capability, options] of Object.entries(profile.options ?? {})) {
        if (options.max === undefined) {
          continue;
        }

        const backend = await homey.request(`/manager/devices/device/${device.id}`);
        assert.equal(backend.capabilitiesObj[capability].min, options.min);
        assert.equal(backend.capabilitiesObj[capability].max, options.max);
        assert.equal(backend.capabilitiesObj[capability].step, options.step);
        await homey.set(device.id, capability, options.max);
        assert.equal(await homey.value(device.id, capability), options.max, 'The declared upper boundary is usable');
      }

      await homey.availability(device, false);
      assert.equal((await homey.fixture(device)).available, false);
      assert.equal((await homey.request(`/manager/devices/device/${device.id}`)).available, false);
      await homey.availability(device, true);
      assert.equal((await homey.fixture(device)).available, true);
      await assert.rejects(homey.report(device, { not_a_capability: true }));
    });
  }
});
