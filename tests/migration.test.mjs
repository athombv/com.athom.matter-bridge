import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ControllerBehavior, Endpoint, Environment, fromJson, Logger, ServerNode } from '@matter/main';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { OnOffLightDevice } from '@matter/main/devices/on-off-light';
import { OnOff } from '@matter/main/clusters/on-off';
import { Invoke } from '@matter/main/protocol';
import { BridgeCommissioningServer } from '../lib/BridgeCommissioningServer.mjs';

Logger.level = 'error';

test('0.15.6 disk storage retains both controllers and endpoint identities on upgrade', { timeout: 90000 }, async (t) => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/matter-0.15.6.json', import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'matter-upgrade-'));
  const nodes = [];
  t.after(async () => {
    for (const node of nodes.reverse()) await node.close();
    await Environment.default.runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const [path, contents] of Object.entries(fixture.files)) {
    // Keep controller credentials, but rebuild their client-side endpoint caches with the new API.
    // The bridge's storage is copied unchanged; no controller is commissioned again.
    if (path.startsWith('first/nodes.') || path.startsWith('second/nodes.')) {
      continue;
    }

    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  Environment.default.vars.set('storage.path', directory);
  const server = await ServerNode.create(ServerNode.RootEndpoint.with(BridgeCommissioningServer), {
    id: 'bridge', network: { port: 0 },
  });
  nodes.push(server);
  const aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
  const light = new Endpoint(OnOffLightDevice, { id: 'light' });
  await server.add(aggregator);
  await aggregator.add(light);
  await server.start();

  assert.equal(server.lifecycle.isCommissioned, true);
  assert.equal(Object.keys(server.state.commissioning.fabrics).length, 2);
  assert.equal(server.state.basicInformation.uniqueId, JSON.parse(fixture.files['bridge/root.basicInformation.uniqueId']));
  assert.equal(aggregator.number, JSON.parse(fixture.files['bridge/root.parts.aggregator.__number__']));
  assert.equal(light.number, JSON.parse(fixture.files['bridge/root.parts.aggregator.parts.light.__number__']));
  const pairing = await server.act((agent) => { return agent.get(BridgeCommissioningServer).getLocalPairing(); });
  assert.equal(pairing.status, 'idle');
  assert.equal(pairing.qrPairingCode, null);

  for (const [id, command, expected] of [['first', 'on', true], ['second', 'off', false]]) {
    const controller = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
      id, network: { port: 0 },
    });
    nodes.push(controller);
    await controller.start();
    const address = fromJson(fixture.files[`${id}/nodes.peer1.endpoints.0.commissioning.peerAddress`]);
    const peer = await controller.peers.forAddress(address);
    await peer.start();
    const request = Invoke({ commands: [{ endpoint: light.number, cluster: OnOff.Cluster, command }] });
    for await (const chunk of peer.interaction.invoke(request)) {
      for (const response of chunk) {
        if (response.kind === 'cmd-status') assert.equal(response.status, 0);
      }
    }
    assert.equal(light.state.onOff.onOff, expected);
  }
});
