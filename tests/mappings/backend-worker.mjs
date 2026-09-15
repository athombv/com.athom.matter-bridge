import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import { Rpc } from './Rpc.mjs';
import { matchesAttributePath } from './matchesAttributePath.mjs';

const backendPath = process.argv[2];
const requireBackend = createRequire(resolve(backendPath, 'package.json'));
async function backendFile(path) {
  return await import(pathToFileURL(resolve(backendPath, path)).href);
}
const { AttributeCollection, EventCollection } = await import(
  pathToFileURL(requireBackend.resolve('@athombv/homey-matter')).href
);
const { DummyHomeyMatter } = await backendFile(
  'packages/homey-local/test/matter/util/dummies/DummyHomeyMatter.mts',
);
const { createMatterTestHomey } = await backendFile(
  'packages/homey-local/test/matter/util/stubs/MatterTestHomey.mts',
);
const { MatterNodeUpdates } = await backendFile(
  'packages/homey-local/lib/matter/mixins/MatterNodeUpdates.mts',
);
const { MatterDevice } = await backendFile('packages/homey-local/lib/matter/MatterDevice.mts');

let homey;
let node;
let devices;
let transport;
const rpc = new Rpc(process, async (method, args) => {
  switch (method) {
    case 'init': {
      transport = new DummyHomeyMatter();
      transport.read = async (nodeId, paths) => {
        const attributes = await rpc.call('read', { paths });
        return {
          attributeCollection: new AttributeCollection(attributes),
          eventCollection: new EventCollection({}),
          highestReceivedEventNumber: null,
        };
      };
      transport.writeAttributes = async (nodeId, attributes, options) => {
        for (const { endpointId, attribute, value } of attributes) {
          await rpc.call('write', {
            endpointId,
            clusterId: attribute.cluster.id,
            attributeId: attribute.id,
            hex: Buffer.from(attribute.schema.encode(value)).toString('hex'),
            timeout: options?.timedInteractionTimeoutMs,
          });
        }
      };
      transport.sendCommand = async ({ endpointId, command, args, options }) => {
        const response = await rpc.call('invoke', {
          endpointId,
          clusterId: command.cluster.id,
          commandId: command.clientId,
          hex: Buffer.from(command.clientSchema.encode(args)).toString('hex'),
          timeout: options?.timedInteractionTimeoutMs,
        });
        if (response?.hex) {
          return command.serverSchema.decode(Buffer.from(response.hex, 'hex'));
        }
      };

      const setup = await createMatterTestHomey(transport);
      homey = setup.homey;
      node = await setup.managerMatter.createMatterNode({
        matternode: { nodeId: 0xdeadbeef, isInPairSession: true },
      });
      await MatterNodeUpdates.updateNode(node, { forceUpdate: true });
      devices = await node.getDevicesForNode();
      await nextImmediate();

      // Deliver the initial subscription report through the backend's subscription handler.
      const attributes = await rpc.call('read');
      for (const [key, hex] of Object.entries(attributes)) {
        await report({ key, hex });
      }

      const deviceSnapshot = await snapshot();
      const paths = transport.collectionSubscriptions.flatMap((subscription) => {
        return subscription.paths;
      });
      return { devices: deviceSnapshot, paths };
    }
    case 'snapshot':
      return await snapshot();
    case 'report':
      await report(args);
      return;
    case 'set': {
      const device = devices.find((device) => {
        return device.id === args.deviceId;
      });
      if (!device) {
        throw new Error(`No reconstructed device ${args.deviceId}`);
      }
      await MatterDevice.onSetCapabilityValue(device, {
        capabilityId: args.capabilityId,
        value: args.value,
        node,
        opts: {},
      });
      return;
    }
    case 'close': {
      if (!homey) {
        return;
      }

      const userPath = homey.config.HOMEY_USER_PATH;
      await homey.onUninit();
      await rm(resolve(userPath, '../..'), { recursive: true, force: true });
      homey = undefined;
      return;
    }

    default:
      throw new Error(`Unknown backend operation ${method}`);
  }
});

async function report({ key, hex }) {
  const [endpointId, clusterId, attributeId] = key.split('.').map(Number);

  for (const subscription of transport?.collectionSubscriptions ?? []) {
    const match = subscription.paths.some((path) => {
      return matchesAttributePath(path, { endpointId, clusterId, attributeId });
    });
    if (!match) {
      continue;
    }
    await transport.globalEventsListener.onSubscriptionData({
      readClientId: subscription.subscriptionId,
      nodeId: node.nodeId,
      path: { endpointId, clusterId, attributeId },
      tlvData: Buffer.from(hex, 'hex'),
    });
  }
}

async function snapshot() {
  const result = [];

  for (const device of devices ?? []) {
    const capabilities = [];
    for (const id of device.capabilities) {
      const mapping = device.store.matter?.capabilities[id];
      if (!mapping) {
        continue;
      }

      const value = await device.getCapabilityValue({ capabilityId: id });
      capabilities.push({
        id,
        endpointId: mapping.endpointId,
        clusterId: mapping.clusterId,
        value,
      });
    }
    result.push({ id: device.id, class: device.class, capabilities });
  }

  return result;
}
process.send({ ready: true });
