import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { FabricManager, SessionManager } from '@matter/main/protocol';
import { Groupcast } from '@matter/main/clusters/groupcast';
import { TlvInvokeRequest } from '@matter/main/types';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { eventually } from './mappings/eventually.mjs';

// Independent wire encoder: do not use matter.js MessageCodec/GroupSession on the
// sending side, which could hide matching privacy bugs in the encoder and decoder.
class PrivacyGroupMessage {
  static encode({ key, sourceNodeId, groupId, counter, commandId }) {
    const sessionId = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'GroupKeyHash', 2)).readUInt16BE();
    const header = Buffer.alloc(18);
    header[0] = 0x06; // Source node ID and destination group ID present.
    header.writeUInt16LE(sessionId, 1);
    header[3] = 0x81; // Privacy flag (bit 7), group session (bit 0).
    header.writeUInt32LE(counter, 4);
    header.writeBigUInt64LE(sourceNodeId, 8);
    header.writeUInt16LE(groupId, 16);

    const exchange = Buffer.from([1, 8, 0, 0, 1, 0]); // Initiator, InvokeRequest, protocol 1.
    exchange.writeUInt16LE(counter & 0xffff, 2);
    const invoke = TlvInvokeRequest.encode({
      suppressResponse: true,
      timedRequest: false,
      invokeRequests: [{ commandPath: { clusterId: 6, commandId } }],
      interactionModelRevision: 12,
    });
    const payload = Buffer.concat([exchange, invoke]);
    const nonce = Buffer.alloc(13);
    nonce[0] = header[3];
    nonce.writeUInt32LE(counter, 1);
    nonce.writeBigUInt64LE(sourceNodeId, 5);
    const cipher = createCipheriv('aes-128-ccm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(header, { plaintextLength: payload.length });
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const mic = cipher.getAuthTag();

    // Matter 1.6.1 section 4.9: privacy nonce is session ID (BE) + last 11 MIC bytes.
    // CCM's first payload counter block is 0x01 || nonce || 0x0001 (L = 2).
    const privacyKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'PrivacyKey', 16));
    const counterBlock = Buffer.alloc(16);
    counterBlock[0] = 1;
    counterBlock.writeUInt16BE(sessionId, 1);
    mic.copy(counterBlock, 3, 5);
    counterBlock.writeUInt16BE(1, 14);
    const privacy = createCipheriv('aes-128-ctr', privacyKey, counterBlock);
    const hiddenHeader = Buffer.concat([privacy.update(header.subarray(4)), privacy.final()]);
    assert.notDeepEqual(hiddenHeader, header.subarray(4));

    return Buffer.concat([header.subarray(0, 4), hiddenHeader, encrypted, mic]);
  }
}

test('privacy-enabled group commands reach only group members before and after restart', { timeout: 30000 }, async (t) => {
  const harness = await BridgeHarness.create(['member', 'nonmember'].map((id) => {
    return { id, class: 'socket', capabilities: { onoff: { value: true, setable: true } } };
  }));
  t.after(async () => {
    await harness.close();
  });
  const member = harness.endpoint('member');
  const nonmember = harness.endpoint('nonmember');
  const fabric = [...harness.bridge.serverNode.env.get(FabricManager)][0];
  const controllerFabric = [...harness.controller.env.get(FabricManager)][0];
  const epochKey = Buffer.alloc(16, 17);
  const groupId = 31;

  await harness.invoke(0, 'GroupKeyManagement', 'keySetWrite', { groupKeySet: {
    groupKeySetId: 42, groupKeySecurityPolicy: 0,
    epochKey0: epochKey, epochStartTime0: BigInt(Date.UTC(2026, 0, 1)) * 1000n,
    epochKey1: null, epochStartTime1: null, epochKey2: null, epochStartTime2: null,
  } });
  await harness.write(0, 'GroupKeyManagement', 'groupKeyMap', [
    { groupId, groupKeySetId: 42, fabricIndex: fabric.fabricIndex },
  ]);
  const acl = await harness.read(0, 'AccessControl', 'acl');
  await harness.write(0, 'AccessControl', 'acl', [...acl, {
    privilege: 3, authMode: 3, subjects: [BigInt(groupId)], targets: null, fabricIndex: fabric.fabricIndex,
  }]);
  const added = await harness.invoke(member, 'Groups', 'addGroup', { groupId, groupName: 'Private group' });
  assert.equal(added[0].data.status, 0);

  const salt = Buffer.from(fabric.globalId.toString(16).padStart(16, '0'), 'hex');
  const key = Buffer.from(hkdfSync('sha256', epochKey, salt, 'GroupKey v1.0', 16));
  const socket = createSocket('udp4');
  const send = promisify(socket.send.bind(socket));
  t.after(() => {
    socket.close();
  });
  let counter = 100;

  for (const restart of [false, true]) {
    if (restart) {
      await harness.restart();
      assert.equal(harness.endpoint('member'), member);
    }

    for (const [commandId, expected] of [[0, false], [1, true]]) {
      const packet = PrivacyGroupMessage.encode({
        key, sourceNodeId: controllerFabric.nodeId, groupId, counter: counter++, commandId,
      });
      assert.equal(packet[3], 0x81, 'The actual datagram must carry the privacy flag');
      // Deliver the group-addressed wire packet over local UDP. This tests reception and
      // dispatch without depending on the host routing IPv6 multicast to itself.
      await send(packet, harness.bridge.serverNode.state.network.operationalPort, '127.0.0.1');
      await eventually(() => {
        assert.equal(harness.devices.member.writes.at(-1)?.value, expected);
      }, 'Privacy-enhanced group command must operate Homey');
      await harness.expectReport(member, 'OnOff', 'onOff', expected);
      assert.equal(await harness.read(nonmember, 'OnOff', 'onOff'), true);
      assert.equal(harness.devices.nonmember.attempts, 0);
    }
  }

  const writes = harness.devices.member.writes.length;
  const received = [];
  const sessions = harness.bridge.serverNode.env.get(SessionManager);
  const onGroupMessage = (event) => {
    received.push(event);
  };
  sessions.onGroupMessage.on(onGroupMessage);
  t.after(() => {
    sessions.onGroupMessage.off(onGroupMessage);
  });
  const corrupt = PrivacyGroupMessage.encode({
    key, sourceNodeId: controllerFabric.nodeId, groupId, counter: counter++, commandId: 0,
  });
  corrupt[corrupt.length - 1] ^= 1;
  await send(corrupt, harness.bridge.serverNode.state.network.operationalPort, '127.0.0.1');
  await eventually(() => {
    assert.ok(received.some((event) => {
      // 0.18.1 reports unauthenticated packets separately from authenticated results.
      return event.kind === 'unauthenticated' || event.result === Groupcast.GroupcastTestResult.FailedAuth;
    }), 'The UDP receiver must process and reject the corrupted message');
  }, 'Observe rejection before checking that the device was not operated');
  assert.equal(harness.devices.member.writes.length, writes, 'An unauthenticated packet must not operate Homey');
  assert.deepEqual(harness.errors, []);
});
