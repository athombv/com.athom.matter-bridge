import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Environment, fromJson, ServerNode, StorageManager } from '@matter/main';
import { PeerAddress, SessionManager } from '@matter/main/protocol';
import { SubscriptionsServer } from '@matter/node/behaviors/system/subscriptions';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { eventually } from './mappings/eventually.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/matter-0180-storage.json', import.meta.url)));
const legacyRecords = fromJson(fixture.files['mapping-bridge/sessions.resumptionRecords']);
const legacySubscriptions = fromJson(fixture.files['mapping-bridge/root.subscriptions.subscriptions']);

// Check migration before any connection can replace the old session records or subscriptions.
test('0.18.1 migrates legacy resumption records and loads the original persisted subscription', {
  timeout: 30000,
}, async (t) => {
  assert.equal(fixture.matterJsVersion, '0.18.0');
  assert.equal(legacyRecords.length, 1);
  assert.equal(legacySubscriptions.length, 1);
  const directory = await mkdtemp(join(tmpdir(), 'matter-peer-migration-'));
  let node;
  t.after(async () => {
    await node?.close();
    await Environment.default.runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

  for (const [path, contents] of Object.entries(fixture.files)) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  for (const restart of [false, true]) {
    const environment = new Environment('storage-migration', Environment.default);
    environment.vars.set('storage.path', directory);
    node = await ServerNode.create({ id: 'mapping-bridge', environment, network: { port: 0 } });
    assert.equal(node.lifecycle.isCommissioned, true);
    assert.equal(node.state.basicInformation.nodeLabel, '日'.repeat(10), 'Stored labels are shortened at code-point boundaries');
    const sessions = node.env.get(SessionManager);
    await sessions.construction;

    for (const old of legacyRecords) {
      const address = PeerAddress({ fabricIndex: old.fabricIndex, nodeId: old.peerNodeId });
      const restored = sessions.findResumptionRecordByAddress(address);
      assert.ok(restored, 'Keep the old session credentials before reconnecting');
      assert.deepEqual(restored.resumptionId, old.resumptionId);
      assert.deepEqual(restored.sharedSecret, old.sharedSecret);
      assert.equal(restored.peerNodeId, old.peerNodeId);
      const storage = node.env.get(StorageManager).createContext('sessions');
      assert.equal(await storage.has('resumptionRecords'), false, 'Remove the legacy array after migration');
      const record = await storage.createContext('resumption').createContext(String(old.fabricIndex))
        .get(old.peerNodeId.toString(16));
      assert.deepEqual(record.resumptionId, old.resumptionId);
      assert.deepEqual(record.sharedSecret, old.sharedSecret);
    }

    if (!restart) {
      await node.act(async (agent) => {
        const subscriptions = agent.get(SubscriptionsServer);
        await subscriptions.beginRun();
        const restored = subscriptions.internal.formerSubscriptions;
        assert.equal(restored.length, legacySubscriptions.length);

        for (const [index, old] of legacySubscriptions.entries()) {
          const { peerAddress, ...fields } = restored[index];
          const { peerAddress: oldAddress, ...oldFields } = old;
          // Model loading expands absent optional fields to undefined. Compare the
          // persisted representation so that expansion does not obscure real changes.
          assert.deepEqual(JSON.parse(JSON.stringify(fields)), oldFields,
            'Preserve subscription ID, paths, intervals and filtering');
          assert.equal(peerAddress.fabricIndex, oldAddress.fabricIndex);
          assert.equal(peerAddress.nodeId, oldAddress.nodeId);
        }

        assert.deepEqual(subscriptions.state.subscriptions, [], 'Consume the legacy array');
      });
    }

    await node.close();
    node = undefined;
  }
});

test('0.18.0 storage reconnects without pairing and retains names, identities and reports', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create(fixture.fixtures, { storageFixture: fixture });
  t.after(async () => {
    await harness.close();
  });
  const id = 'migration-socket';
  const old = legacySubscriptions[0];

  for (const restart of [false, true]) {
    if (restart) {
      await harness.restart();
    }

    assert.equal(harness.bridge.serverNode.lifecycle.isCommissioned, true);
    assert.equal(harness.bridge.deviceEndpoints[id].number, fixture.parent);
    assert.equal(harness.endpoint(id), fixture.child);
    assert.equal(await harness.read(fixture.parent, 'BridgedDeviceBasicInformation', 'nodeLabel'), id);
    assert.equal(harness.devices[id].attempts, restart ? 1 : 0, 'Startup must not operate Homey');
    const rootLabel = await harness.read(0, 'BasicInformation', 'nodeLabel');
    assert.equal(rootLabel, '日'.repeat(10));

    const storage = harness.bridge.serverNode.env.get(StorageManager).createContext('subscriptions')
      .createContext(String(old.peerAddress.fabricIndex));
    await eventually(async () => {
      const saved = await storage.get(old.peerAddress.nodeId.toString(16), []);
      const active = saved.find((subscription) => {
        return subscription.subscriptionId === harness.subscription.subscriptionId;
      });
      assert.ok(active, 'The active subscription must be persisted under its peer');
      assert.ok(active.attributeRequests.length > 0);
    }, 'Persist the reconnected subscription in the new format');
    assert.deepEqual(harness.bridge.serverNode.state.subscriptions.subscriptions, []);

    await harness.invoke(fixture.child, 'OnOff', restart ? 'on' : 'off');
    await harness.expectReport(fixture.child, 'OnOff', 'onOff', restart);
    assert.deepEqual(harness.errors, []);
  }
});
