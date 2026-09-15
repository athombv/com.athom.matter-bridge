import assert from 'node:assert/strict';
import { Matter } from '@matter/model';
import { TlvOfModel, TlvAny } from '@matter/main/types';
import { Invoke, Write } from '@matter/main/protocol';
import { BridgeHarness } from './BridgeHarness.mjs';
import { matchesAttributePath } from './matchesAttributePath.mjs';

// This boundary forwards Matter values without applying Homey capability conversions.
export class BridgeTransport {
  #harness;
  #rpc;
  #subscriptions = [];

  constructor(harness) {
    this.#harness = harness;
  }

  async handle(method, args) {
    switch (method) {
      case 'read':
        return await this.#read(args);
      case 'write':
        await this.#write(args);
        return;
      case 'invoke':
        return await this.#invoke(args);
      default:
        throw new Error(`Unexpected transport operation ${method}`);
    }
  }

  async #read({ paths: requestedPaths = [{ attributeId: 0xffffffff }] }) {
    const attributes = {};
    const paths = [];

    for (const path of requestedPaths) {
      if (!('attributeId' in path)) {
        continue;
      }

      paths.push({
        endpointId: path.endpointId === 0xffff ? undefined : path.endpointId,
        clusterId: path.clusterId === 0xffffffff ? undefined : path.clusterId,
        attributeId: path.attributeId === 0xffffffff ? undefined : path.attributeId,
      });
    }

    if (!paths.length) {
      return attributes;
    }

    const reports = await this.#harness.readRaw(paths);

    for (const report of reports) {
      if (report.kind !== 'attr-value') {
        continue;
      }

      attributes[BridgeHarness.key(report.path)] = BridgeTransport.#encodeReport(report);
    }

    return attributes;
  }

  async #write({ endpointId, clusterId, attributeId, hex, timeout }) {
    const request = Write({
      writes: [
        {
          path: { endpointId, clusterId, attributeId },
          data: TlvAny.decode(Buffer.from(hex, 'hex')),
        },
      ],
      timeout,
    });
    const result = await this.#harness.peer.interaction.write(request);

    for (const entry of result) {
      if (entry.status !== 0) {
        throw new Error(`Matter write rejected: ${entry.status}`);
      }
    }
  }

  async #invoke({ endpointId, clusterId, commandId, hex, timeout }) {
    const request = Invoke({
      commands: [
        {
          endpoint: endpointId,
          cluster: { id: clusterId, name: `Cluster${clusterId}` },
          command: {
            requestId: commandId,
            requestSchema: TlvAny,
            responseSchema: TlvAny,
            timed: !!timeout,
          },
          fields: TlvAny.decode(Buffer.from(hex, 'hex')),
        },
      ],
      timeout,
    });

    for await (const chunk of this.#harness.peer.interaction.invoke(request)) {
      for (const response of chunk) {
        if (response.kind === 'cmd-status' && response.status !== 0) {
          throw new Error(`Matter command rejected: ${response.status}`);
        }
        if (response.kind === 'cmd-response') {
          return { hex: Buffer.from(TlvAny.encode(response.data)).toString('hex') };
        }
      }
    }

    return {};
  }

  subscribe(rpc, paths) {
    this.#rpc = rpc;
    this.#subscriptions = paths;
  }

  async forwardReport(report) {
    const subscribed = this.#subscriptions.some((path) => {
      return matchesAttributePath(path, report.path);
    });

    if (!subscribed) {
      return;
    }

    await this.#rpc.call('report', {
      key: BridgeHarness.key(report.path),
      hex: BridgeTransport.#encodeReport(report),
    });
  }

  static #encodeReport(report) {
    const { clusterId, attributeId } = report.path;
    const model =
      Matter.clusters(clusterId)?.attributes(attributeId) ?? Matter.attributes(attributeId);

    assert.ok(model, `No TLV model for ${clusterId}/${attributeId}`);

    return Buffer.from(TlvOfModel(model).encode(report.value)).toString('hex');
  }
}
