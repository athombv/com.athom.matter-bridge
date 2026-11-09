import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { ControllerBehavior, Environment, Logger, ServerNode } from '@matter/main';
import { ClientInteraction, Invoke, PeerSet, Read, Subscribe } from '@matter/main/protocol';
import { BridgedDeviceBasicInformation } from '@matter/main/clusters/bridged-device-basic-information';
import { Descriptor } from '@matter/main/clusters/descriptor';
import { QrPairingCodeCodec } from '@matter/main/types';
import { APP_ID } from '../../../scripts/integration/config.mjs';
import { eventually } from './eventually.mjs';

Logger.level = 'error';

export class MatterController {
  reports = new Map();

  async connect(homey) {
    Environment.default.vars.set('storage.path', await mkdtemp('/tmp/bridge-controller-'));
    this.node = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
      id: 'integration-controller', network: { port: 0 },
    });
    let state = await homey.state();

    if (state.commissioned) {
      state = await homey.request(`/app/${APP_ID}/pairing/start`, { method: 'POST' });
    }

    const [code] = QrPairingCodeCodec.decode(state.qrPairingCode ?? state.pairing.qrPairingCode);
    this.peer = await this.node.peers.commission({
      passcode: code.passcode, longDiscriminator: code.discriminator, timeout: 30000,
      onAttestationFailure: true, // This is an uncertified development app.
    });
    await this.peer.set({ network: { autoSubscribe: false } });
    await this.peer.start();
    const protocolPeer = this.node.env.get(PeerSet).for(this.peer.state.commissioning.peerAddress);

    // Read wire values directly; the client endpoint cache can lag topology changes.
    this.interaction = new ClientInteraction({ environment: this.peer.env, exchangeProvider: protocolPeer.exchangeProvider });
    this.subscription = await this.interaction.subscribe({
      ...Subscribe({ attributes: [{}], minIntervalFloor: 0, maxIntervalCeiling: 60 }),
      updated: async (chunks) => {
        for await (const chunk of chunks) {
          for await (const entry of chunk) {
            if (entry.kind === 'attr-value') {
              this.reports.set(MatterController.key(entry.path), entry.value);
            }
          }
        }
      },
    });
  }

  static key(path) {
    return `${path.endpointId}.${path.clusterId}.${path.attributeId}`;
  }

  async read(paths) {
    const values = [];

    for await (const chunk of this.interaction.read(Read({ attributes: paths }))) {
      for await (const entry of chunk) {
        if (entry.kind === 'attr-value') {
          values.push(entry);
        }
      }
    }

    return values;
  }

  async endpoint(name) {
    const cluster = BridgedDeviceBasicInformation.Cluster;
    const labels = await this.read([{ clusterId: cluster.id, attributeId: cluster.attributes.nodeLabel.id }]);
    const parent = labels.find((entry) => { return entry.value === name; });

    if (!parent) {
      return undefined;
    }

    const parts = await this.read([{ endpointId: parent.path.endpointId, clusterId: Descriptor.Cluster.id, attributeId: Descriptor.Cluster.attributes.partsList.id }]);
    return parts[0]?.value[0];
  }

  async path(device, cluster, attribute) {
    const endpointId = await this.endpoint(device.name);
    assert.notEqual(endpointId, undefined, `${device.name} must be discoverable over Matter`);
    return { endpointId, clusterId: cluster.id, attributeId: cluster.attributes[attribute].id };
  }

  async value(path) {
    return (await this.read([path]))[0]?.value;
  }

  async expectUpdate(homey, device, capability, value, cluster, attribute, expected) {
    const path = await this.path(device, cluster, attribute);
    assert.notEqual(await this.value(path), expected, 'Push verification must exercise an actual value change');
    this.reports.delete(MatterController.key(path));
    await homey.set(device.id, capability, value);
    await eventually(`${device.name}/${capability}: backend update must reach Matter`, async () => {
      return await this.value(path);
    }, expected);
    await eventually(`${device.name}/${capability}: update must arrive on the existing subscription`, async () => {
      return this.reports.get(MatterController.key(path));
    }, expected);
  }

  async command(device, cluster, command) {
    const endpoint = await this.endpoint(device.name);
    let successes = 0;

    for await (const chunk of this.interaction.invoke(Invoke({ commands: [{ endpoint, cluster, command }] }))) {
      for await (const entry of chunk) {
        if (entry.kind === 'cmd-status') {
          assert.equal(entry.status, 0, 'Matter command must succeed');
          successes += 1;
        }
      }
    }

    assert.equal(successes, 1, 'Matter must acknowledge the command');
  }

  async close() {
    try {
      await this.subscription?.close();
      await this.interaction?.close();
      await this.peer?.decommission();
    } finally {
      try {
        await this.node?.peers.close();
        await this.node?.close();
      } finally {
        await Environment.default.runtime.close();
      }
    }
  }
}
