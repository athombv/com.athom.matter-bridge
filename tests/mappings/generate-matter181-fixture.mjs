// Run with the stable 0.18.0 SDK, before testing the 0.18.1 migration.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fromJson, toJson } from '@matter/main';
import { BridgeHarness } from './BridgeHarness.mjs';
import { eventually } from './eventually.mjs';

const matter = JSON.parse(await readFile(new URL('../../node_modules/@matter/main/package.json', import.meta.url)));
assert.equal(matter.version, '0.18.0', 'Generate with the actual previous SDK');
const fixtures = [{ id: 'migration-socket', class: 'socket', capabilities: { onoff: { value: true, setable: true } } }];
const harness = await BridgeHarness.create(fixtures);

try {
  // Values accepted under the former UTF-16 limit, but oversized in UTF-8 bytes.
  await harness.write(0, 'BasicInformation', 'nodeLabel', '日'.repeat(11));
  const parent = harness.bridge.deviceEndpoints['migration-socket'].number;
  await harness.write(parent, 'BridgedDeviceBasicInformation', 'nodeLabel', '💡'.repeat(9));
  const subscriptionPath = join(harness.directory, 'mapping-bridge/root.subscriptions.subscriptions');
  await eventually(async () => {
    const subscriptions = fromJson(await readFile(subscriptionPath, 'utf8'));
    assert.equal(subscriptions.length, 1);
  }, 'Snapshot must contain the real active subscription');

  // Stop the bridge before the controller: shutdown retains its active subscription,
  // whereas explicitly closing the subscription first would delete the migration input.
  const peerAddress = toJson(harness.peer.state.commissioning.peerAddress);
  const child = harness.endpoint('migration-socket');
  await harness.bridge.stop();
  await harness.controller.close();

  const files = {};
  for (const entry of await readdir(harness.directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    files[path.slice(harness.directory.length + 1)] = await readFile(path, 'utf8');
  }

  assert.equal(fromJson(files['mapping-bridge/root.subscriptions.subscriptions']).length, 1);
  assert.equal(fromJson(files['mapping-bridge/sessions.resumptionRecords']).length, 1);
  assert.equal(fromJson(files['mapping-controller/sessions.resumptionRecords']).length, 1);
  const snapshot = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    matterJsVersion: matter.version,
    fixtures,
    peerAddress,
    parent,
    child,
    files,
  };
  await writeFile(new URL('../fixtures/matter-0180-storage.json', import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Saved ${Object.keys(files).length} synthetic storage files with an active subscription`);
} finally {
  await harness.close();
}
