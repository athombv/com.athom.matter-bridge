// Local maintenance command. Public CI consumes the saved synthetic storage, never Git history.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { toJson } from '@matter/main';
import { BridgeHarness } from './BridgeHarness.mjs';
import { mappings } from './manifest.mjs';

const revision = 'd340d3eb932feb81b0d03423cc4383ffdbdbeaf2';
const fullRevision = execFileSync('git', ['rev-parse', revision], { encoding: 'utf8' }).trim();
const original = execFileSync('git', ['show', `${fullRevision}:lib/MatterBridgeServer.mjs`], {
  encoding: 'utf8',
});
const moduleUrl = new URL('./artifacts/previous-release.mjs', import.meta.url);
await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
await writeFile(moduleUrl, original.replaceAll("from './", "from '../../../lib/"));
let harness;
try {
  const { default: PreviousBridge } = await import(moduleUrl.href);
  harness = await BridgeHarness.create(mappings, { serverClass: PreviousBridge });
  const endpoints = {};
  for (const fixture of mappings) {
    endpoints[fixture.id] = [...(harness.bridge.deviceEndpointInstances[fixture.id] ?? [])].map(
      (endpoint) => {
        return { id: endpoint.id, number: endpoint.number };
      },
    );
  }
  // Persist representative changes through the released subscription handlers.
  for (const device of Object.values(harness.devices)) {
    for (const [id, value] of Object.entries({
      onoff: false,
      dim: 0.25,
      light_hue: 0.25,
      light_saturation: 0.25,
      light_temperature: 1,
      light_mode: 'color',
      target_temperature: 30,
      'target_temperature.cool': 30,
      windowcoverings_set: 1,
      windowcoverings_state: 'down',
      alarm_smoke: false,
    })) {
      if (device.capabilitiesObj[id]) {
        device.emit(id, value);
      }
    }
  }
  await delay(100);
  for (const device of Object.values(harness.devices)) {
    if (device.capabilitiesObj.onoff) {
      device.emit('onoff', true);
    }
    if (device.capabilitiesObj.alarm_smoke) {
      device.emit('alarm_smoke', true);
    }
  }
  await delay(100);
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
    new URL('../fixtures/mapping-upgrade.json', import.meta.url),
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
  }
}
