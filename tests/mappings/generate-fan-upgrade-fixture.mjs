// Local maintenance command. Public CI consumes the saved synthetic storage, never Git history.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { toJson } from '@matter/main';
import { BridgeHarness } from './BridgeHarness.mjs';

const mappings = [{
  id: 'legacy-fan', class: 'fan', capabilities: {
    onoff: { value: true, type: 'boolean', setable: true },
    'number.fixture_fan_speed': { value: 13, type: 'number', min: 1, max: 26, step: 1, setable: true },
  },
}];

const revision = '5b95e303fed23ca401e2d59b999fb0d60b0c44f0';
const fullRevision = execFileSync('git', ['rev-parse', revision], { encoding: 'utf8' }).trim();
const original = execFileSync('git', ['show', `${fullRevision}:lib/MatterBridgeServer.mjs`], {
  encoding: 'utf8',
});
const moduleUrl = new URL('./artifacts/previous-fan-release.mjs', import.meta.url);
await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
const fanUrl = new URL('./artifacts/previous-fan-mapping.mjs', import.meta.url);
await writeFile(fanUrl, execFileSync('git', ['show', `${fullRevision}:lib/mappings/FanMapping.mjs`], { encoding: 'utf8' }));
await writeFile(moduleUrl, original.replaceAll("from './", "from '../../../lib/")
  .replace("from '../../../lib/mappings/FanMapping.mjs'", "from './previous-fan-mapping.mjs'"));
let harness;
try {
  const { MatterBridgeServer: PreviousBridge } = await import(moduleUrl.href);
  harness = await BridgeHarness.create(mappings, { serverClass: PreviousBridge });
  const endpoints = {};
  for (const fixture of mappings) {
    endpoints[fixture.id] = [...(harness.bridge.deviceEndpointInstances[fixture.id] ?? [])].map(
      (endpoint) => {
        return { id: endpoint.id, number: endpoint.number };
      },
    );
  }
  const peerAddress = toJson(harness.peer.state.commissioning.peerAddress);
  await harness.subscription.close();
  harness.subscription = undefined;
  await harness.controller.close();
  await harness.bridge.stop();
  const files = {};
  for (const path of await readdir(harness.directory, { recursive: true })) {
    // Rebuild only client endpoint caches; retain bridge storage and controller credentials.
    if (path.startsWith('mapping-controller/nodes.')) {
      continue;
    }
    const target = join(harness.directory, path);
    try {
      files[path] = await readFile(target, 'utf8');
    } catch (error) {
      if (error.code !== 'EISDIR') {
        throw error;
      }
    }
  }
  assert.ok(Object.keys(files).length);
  await writeFile(
    new URL('../fixtures/fan-policy-upgrade.json', import.meta.url),
    JSON.stringify(
      { revision: fullRevision, matterJsVersion: '0.17.9', peerAddress, endpoints, files },
      null,
      2,
    ) + '\n',
  );
  console.log(`Saved synthetic previous-release storage: ${Object.keys(files).length} files`);
} finally {
  try {
    await harness?.close();
  } finally {
    await rm(moduleUrl, { force: true });
    await rm(fanUrl, { force: true });
  }
}
