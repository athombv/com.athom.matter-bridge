// Run in an archived checkout of this revision with npm ci, before installing Matter.js 0.18.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toJson } from '@matter/main';
import { Invoke, Write } from '@matter/main/protocol';
import { GroupKeyManagement } from '@matter/main/clusters/group-key-management';
import { BridgeHarness } from './BridgeHarness.mjs';
import { mappings } from './manifest.mjs';

const revision = 'b4f2d1406bd03bb5fa7a6c1c23cbc9a096312a02';
const matter = JSON.parse(await readFile(new URL('../../node_modules/@matter/main/package.json', import.meta.url)));
assert.equal(matter.version, '0.17.9', 'Generate with the actual previous SDK');
const selected = mappings.filter((fixture) => {
  return ['socket', 'light-extended-temperature', 'lock-false', 'alarm_smoke', 'water-with-battery'].includes(fixture.id);
});
const harness = await BridgeHarness.create(selected);

try {
  const identities = {};
  for (const fixture of selected) {
    const endpoints = [];
    for (const endpoint of harness.bridge.deviceEndpointInstances[fixture.id]) {
      endpoints.push({
        id: endpoint.id,
        number: endpoint.number,
        deviceTypes: await harness.read(endpoint.number, 'Descriptor', 'deviceTypeList'),
      });
    }
    identities[fixture.id] = { parent: harness.bridge.deviceEndpoints[fixture.id].number, endpoints };
  }
  const light = harness.endpoint('light-extended-temperature');
  for await (const chunk of harness.peer.interaction.invoke(Invoke({ commands: [{
    endpoint: 0, cluster: GroupKeyManagement.Cluster, command: 'keySetWrite', fields: {
      groupKeySet: {
        groupKeySetId: 42, groupKeySecurityPolicy: 0,
        epochKey0: new Uint8Array(16).fill(17), epochStartTime0: BigInt(Date.UTC(2026, 0, 1)) * 1000n,
        epochKey1: null, epochStartTime1: null, epochKey2: null, epochStartTime2: null,
      },
    },
  }] }))) {
    for (const response of chunk) {
      assert.equal(response.status, 0);
    }
  }
  const written = await harness.peer.interaction.write(Write(Write.Attribute({
    endpoint: 0, cluster: GroupKeyManagement.Cluster, attributes: 'groupKeyMap',
    value: [{ groupId: 31, groupKeySetId: 42, fabricIndex: 1 }],
  })));
  for (const response of written) {
    assert.equal(response.status, 0);
  }
  for (const [cluster, command, fields] of [
    ['Groups', 'addGroup', { groupId: 31, groupName: 'Retained group' }],
    ['ScenesManagement', 'storeScene', { groupId: 31, sceneId: 7 }],
  ]) {
    const responses = await harness.invoke(light, cluster, command, fields);
    assert.ok(responses.some((response) => {
      return response.data?.status === 0;
    }), `${command} must succeed before saving storage`);
  }
  const peerAddress = toJson(harness.peer.state.commissioning.peerAddress);
  await harness.subscription.close();
  harness.subscription = undefined;
  await harness.controller.close();
  await harness.bridge.stop();

  const files = {};
  for (const entry of await readdir(harness.directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const relative = path.slice(harness.directory.length + 1);
    // Include the old controller cache too: the same fabric must rediscover added cluster members.
    files[relative] = await readFile(path, 'utf8');
  }
  await writeFile(new URL('../fixtures/matter-0179-retained.json', import.meta.url), JSON.stringify({
    revision, matterJsVersion: matter.version, peerAddress, identities, files,
  }, null, 2) + '\n');
  console.log(`Saved ${Object.keys(files).length} synthetic storage files`);
} finally {
  await harness.close();
}
