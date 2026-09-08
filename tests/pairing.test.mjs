import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ControllerBehavior, Crypto, Endpoint, Environment, Logger, ServerNode, StorageBackendMemory, StorageService, Time, TransportInterfaceSet } from '@matter/main';
import { ManualPairingCodeCodec, QrPairingCodeCodec } from '@matter/main/types';
import { DeviceCommissioner, ExchangeProvider, InteractionClientMessenger, Invoke, PaseClient, PaseServer } from '@matter/main/protocol';
import { AdministratorCommissioning } from '@matter/main/clusters/administrator-commissioning';
import { OnOff } from '@matter/main/clusters/on-off';
import { GeneralCommissioningServer } from '@matter/main/behaviors/general-commissioning';
import { GeneralCommissioning } from '@matter/main/clusters/general-commissioning';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { OnOffLightDevice } from '@matter/main/devices/on-off-light';
import { BridgeCommissioningServer } from '../lib/BridgeCommissioningServer.mjs';

Logger.level = 'error';
const logDestination = Logger.destinations.default;
const writeLog = logDestination.write;
const reactorErrors = [];
logDestination.write = (text, message) => {
  if (message.facility === 'Reactors') reactorErrors.push(text);
  writeLog.call(logDestination, text, message);
};
after(async () => {
  await Environment.default.runtime.close();
  logDestination.write = writeLog;
  assert.equal([...Time.timers].some((timer) => { return timer.name === 'Bridge pairing timeout'; }), false);
  assert.deepEqual(reactorErrors, []);
});

async function closeController(controller) {
  // Matter.js 0.15.6's controller teardown removes shared network interfaces from
  // its transport set. Retain them so this fixture can close its real UDP sockets.
  const transports = [...controller.env.get(TransportInterfaceSet)];
  await controller.nodes.close();
  await controller.close();
  await Promise.all(transports.map(async (transport) => { await transport.close(); }));
}

class TestGeneralCommissioningServer extends GeneralCommissioningServer {
  static rejectCompletion = false;
  static rejectedCompletions = 0;

  async commissioningComplete() {
    if (TestGeneralCommissioningServer.rejectCompletion) {
      TestGeneralCommissioningServer.rejectedCompletions += 1;
      return { errorCode: GeneralCommissioning.CommissioningError.InvalidAuthentication, debugText: 'Test rejection' };
    }
    return await super.commissioningComplete();
  }
}

async function availableUdpPort() {
  const socket = createSocket({ type: 'udp6', ipv6Only: false });
  socket.bind(0);
  await once(socket, 'listening');

  try {
    return socket.address().port;
  } finally {
    await new Promise((resolve) => { socket.close(resolve); });
  }
}

async function makeNode(id, type = ServerNode.RootEndpoint, store = {}, port) {
  // Matter.js 0.15.6 binds separate random ports for IPv4 and IPv6 when given 0,
  // but advertises the IPv6 port for both. Pick one free port for both transports.
  port ??= await availableUdpPort();
  const environment = new Environment(id, Environment.default);
  environment.set(StorageService, new StorageService(environment, (namespace) => {
    store[namespace] ??= {};
    return new StorageBackendMemory(store[namespace]);
  }));
  return await ServerNode.create(type, {
    id,
    environment,
    network: { port },
    commissioning: { passcode: 20202021, discriminator: 1604 },
    controller: { adminFabricLabel: id },
  });
}

async function pair(controller, server, code = 20202021) {
  let passcode = code;
  let longDiscriminator = server.state.commissioning.discriminator;
  if (typeof code === 'string') {
    passcode = ManualPairingCodeCodec.decode(code).passcode;
    const pairing = await local(server, 'getLocalPairing');
    const [payload] = QrPairingCodeCodec.decode(pairing.qrPairingCode);
    longDiscriminator = payload.discriminator;
  }
  const peer = await controller.nodes.locate({ longDiscriminator, timeoutSeconds: 10 });
  // Set this before commissioning: 0.15.6 starts the peer before committing its
  // commissioning options. Wildcard reads race endpoint reparenting; this fixture
  // exercises control through explicit wire commands instead.
  await peer.set({ network: { startupSubscription: null } });
  await peer.commission({ passcode, startupSubscription: null });
  return peer;
}

async function local(server, method) {
  return await server.act(async (agent) => {
    return await agent.get(BridgeCommissioningServer)[method]();
  });
}

async function invoke(peer, cluster, command, fields, endpoint = 0) {
  await peer.start();
  const messenger = await InteractionClientMessenger.create(peer.env.get(ExchangeProvider));
  try {
    const timed = cluster.commands[command].timed ?? false;
    if (timed) await messenger.sendTimedRequest(10000);
    const response = await messenger.sendInvokeCommand(Invoke({
      timed,
      commands: [Invoke.Command({ endpoint, cluster, command, fields })],
    }));
    for (const result of response.invokeResponses) {
      if (result.status?.status.status) {
        throw new Error(`Matter command failed: ${result.status.status.status}`);
      }
    }
  } finally {
    await messenger.close();
  }
}

test('pairing lifecycle with real Matter controllers', { timeout: 180000 }, async (t) => {
  const store = {};
  const root = ServerNode.RootEndpoint.with(BridgeCommissioningServer, TestGeneralCommissioningServer);
  let server = await makeNode('bridge', root, store);
  t.after(async () => { await server.close(); });
  const aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
  await server.add(aggregator);
  const light = new Endpoint(OnOffLightDevice, { id: 'light' });
  await aggregator.add(light);
  await server.start();

  const first = await makeNode('first', ServerNode.RootEndpoint.with(ControllerBehavior));
  t.after(async () => { await closeController(first); });
  await first.start();
  const firstPeer = await pair(first, server);
  assert.equal(server.lifecycle.isCommissioned, true);
  const originalFabric = structuredClone(server.state.commissioning.fabrics);
  const originalCodes = { ...server.state.commissioning.pairingCodes };
  const originalNumbers = [aggregator.number, light.number];

  await t.test('opening, repeated start, fresh codes and cancellation', async () => {
    await local(server, 'startLocalPairing');
    const state = await local(server, 'getLocalPairing');
    const [payload] = QrPairingCodeCodec.decode(state.qrPairingCode);
    assert.equal(ManualPairingCodeCodec.decode(state.manualPairingCode).passcode, payload.passcode);
    assert.equal(payload.discoveryCapabilities, QrPairingCodeCodec.decode(originalCodes.qrPairingCode)[0].discoveryCapabilities);
    assert.ok(state.expiresAt > Date.now());
    await Promise.all([local(server, 'startLocalPairing'), local(server, 'startLocalPairing')]);
    assert.deepEqual(await local(server, 'getLocalPairing'), state);
    assert.equal(server.state.administratorCommissioning.adminFabricIndex, null);
    assert.equal(server.state.administratorCommissioning.adminVendorId, null);
    await local(server, 'stopLocalPairing');
    await local(server, 'stopLocalPairing');
    assert.deepEqual(await local(server, 'getLocalPairing'), {
      status: 'cancelled', expiresAt: null, qrPairingCode: null, manualPairingCode: null,
    });
    await local(server, 'startLocalPairing');
    assert.notEqual((await local(server, 'getLocalPairing')).qrPairingCode, state.qrPairingCode);
    await local(server, 'stopLocalPairing');
    assert.deepEqual(server.state.commissioning.fabrics, originalFabric);
    assert.deepEqual(server.state.commissioning.pairingCodes, originalCodes);
  });

  await t.test('timer expires on the server without a settings page', async () => {
    const duration = BridgeCommissioningServer.pairingDurationMs;
    try {
      BridgeCommissioningServer.pairingDurationMs = 50;
      await local(server, 'startLocalPairing');
      const deadline = Date.now() + 3000;
      while ((await local(server, 'getLocalPairing')).status === 'open' && Date.now() < deadline) {
        await delay(20);
      }
    } finally {
      BridgeCommissioningServer.pairingDurationMs = duration;
    }
    assert.equal((await local(server, 'getLocalPairing')).status, 'expired');
    assert.equal((await local(server, 'getLocalPairing')).qrPairingCode, null);
    assert.deepEqual(server.state.commissioning.fabrics, originalFabric);
  });

  await t.test('a failed opening clears credentials and allows retry', async (t) => {
    const mock = t.mock.method(PaseServer, 'fromPin', async () => { throw new Error('Test crypto failure'); });
    await assert.rejects(local(server, 'startLocalPairing'), /Unable to start pairing/);
    assert.equal((await local(server, 'getLocalPairing')).qrPairingCode, null);
    mock.mock.restore();
    await local(server, 'startLocalPairing');
    await local(server, 'stopLocalPairing');
  });

  await t.test('a new attempt waits until expiry cleanup finishes', async (t) => {
    await local(server, 'startLocalPairing');
    const oldCode = (await local(server, 'getLocalPairing')).manualPairingCode;
    const commissioner = server.env.get(DeviceCommissioner);
    const end = commissioner.endCommissioning.bind(commissioner);
    const closed = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const mock = t.mock.method(commissioner, 'endCommissioning', async () => {
      await end();
      closed.resolve();
      await resume.promise;
    });
    const expiry = local(server, 'expireLocalPairing');
    await closed.promise;
    const start = local(server, 'startLocalPairing');
    resume.resolve();
    await Promise.all([expiry, start]);
    mock.mock.restore();
    const state = await local(server, 'getLocalPairing');
    assert.equal(state.status, 'open');
    assert.notEqual(state.manualPairingCode, oldCode);
    await local(server, 'stopLocalPairing');
  });

  await t.test('a partially opened window is cleaned up when advertising fails', async (t) => {
    const commissioner = server.env.get(DeviceCommissioner);
    const open = commissioner.allowEnhancedCommissioning.bind(commissioner);
    const mock = t.mock.method(commissioner, 'allowEnhancedCommissioning', async (...args) => {
      await open(...args);
      throw new Error('Test advertising failure');
    });
    await assert.rejects(local(server, 'startLocalPairing'), /Unable to start pairing/);
    mock.mock.restore();
    assert.equal((await local(server, 'getLocalPairing')).qrPairingCode, null);
    assert.equal(server.state.administratorCommissioning.windowStatus, AdministratorCommissioning.CommissioningWindowStatus.WindowNotOpen);
    await local(server, 'startLocalPairing');
    await local(server, 'stopLocalPairing');
  });

  await t.test('external pairing is reported and cannot be replaced or cancelled locally', async () => {
    const crypto = server.env.get(Crypto);
    const salt = crypto.randomBytes(32);
    const pakePasscodeVerifier = await PaseClient.generatePakePasscodeVerifier(crypto, 34567890, { iterations: 1000, salt });
    const request = { commissioningTimeout: 180, discriminator: 2222, iterations: 1000, salt, pakePasscodeVerifier };
    await invoke(firstPeer, AdministratorCommissioning.Cluster, 'openCommissioningWindow', request);
    assert.equal((await local(server, 'getLocalPairing')).status, 'external');
    await local(server, 'startLocalPairing');
    await local(server, 'stopLocalPairing');
    assert.equal((await local(server, 'getLocalPairing')).status, 'external');
    await invoke(firstPeer, AdministratorCommissioning.Cluster, 'revokeCommissioning');
    await local(server, 'startLocalPairing');
    await assert.rejects(invoke(firstPeer, AdministratorCommissioning.Cluster, 'openCommissioningWindow', request));
    assert.equal((await local(server, 'getLocalPairing')).status, 'open');
    await local(server, 'stopLocalPairing');
  });

  await t.test('failed commissioning rolls back a pending fabric and preserves the first controller', async () => {
    const failing = await makeNode('failing', ServerNode.RootEndpoint.with(ControllerBehavior));
    try {
      await failing.start();
      await local(server, 'startLocalPairing');
      const state = await local(server, 'getLocalPairing');
      const rejectedCompletions = TestGeneralCommissioningServer.rejectedCompletions;
      TestGeneralCommissioningServer.rejectCompletion = true;
      await assert.rejects(pair(failing, server, state.manualPairingCode));
      assert.equal(TestGeneralCommissioningServer.rejectedCompletions, rejectedCompletions + 1);
      assert.notEqual((await local(server, 'getLocalPairing')).status, 'completed');
      await local(server, 'stopLocalPairing');
      assert.equal(server.env.get(DeviceCommissioner).isFailsafeArmed, false);
      assert.deepEqual(server.state.commissioning.fabrics, originalFabric);
    } finally {
      TestGeneralCommissioningServer.rejectCompletion = false;
      await closeController(failing);
    }
  });

  await t.test('an externally armed failsafe is busy and is not cancelled locally', async () => {
    await invoke(firstPeer, GeneralCommissioning.Cluster, 'armFailSafe', { expiryLengthSeconds: 60, breadcrumb: 0 });
    await local(server, 'startLocalPairing');
    await local(server, 'stopLocalPairing');
    assert.equal((await local(server, 'getLocalPairing')).status, 'busy');
    assert.equal(server.env.get(DeviceCommissioner).isFailsafeArmed, true);
    await invoke(firstPeer, GeneralCommissioning.Cluster, 'armFailSafe', { expiryLengthSeconds: 0, breadcrumb: 0 });
  });

  await local(server, 'startLocalPairing');
  const state = await local(server, 'getLocalPairing');
  assert.equal(state.status, 'open');

  const second = await makeNode('second', ServerNode.RootEndpoint.with(ControllerBehavior));
  t.after(async () => { await closeController(second); });
  await second.start();
  const secondPeer = await pair(second, server, state.manualPairingCode);
  assert.equal(Object.keys(server.state.commissioning.fabrics).length, 2);
  assert.equal((await local(server, 'getLocalPairing')).status, 'completed');
  assert.deepEqual([aggregator.number, light.number], originalNumbers);
  await invoke(firstPeer, OnOff.Cluster, 'on', undefined, light.number);
  assert.equal(light.state.onOff.onOff, true);
  await invoke(secondPeer, OnOff.Cluster, 'off', undefined, light.number);
  assert.equal(light.state.onOff.onOff, false);

  await t.test('restart preserves fabrics and endpoint identities, but closes temporary pairing', async () => {
    const fabrics = structuredClone(server.state.commissioning.fabrics);
    const port = server.state.network.operationalPort;
    await local(server, 'startLocalPairing');
    await firstPeer.cancel();
    await secondPeer.cancel();
    await server.close();
    server = await makeNode('bridge', root, store, port);
    const restartedAggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
    await server.add(restartedAggregator);
    const restartedLight = new Endpoint(OnOffLightDevice, { id: 'light' });
    await restartedAggregator.add(restartedLight);
    await server.start();
    assert.equal((await local(server, 'getLocalPairing')).status, 'idle');
    assert.equal((await local(server, 'getLocalPairing')).qrPairingCode, null);
    assert.deepEqual(server.state.commissioning.fabrics, fabrics);
    assert.deepEqual([restartedAggregator.number, restartedLight.number], originalNumbers);
    assert.deepEqual(server.state.commissioning.pairingCodes, originalCodes);
    await invoke(firstPeer, OnOff.Cluster, 'on', undefined, restartedLight.number);
    assert.equal(restartedLight.state.onOff.onOff, true);
    await invoke(secondPeer, OnOff.Cluster, 'off', undefined, restartedLight.number);
    assert.equal(restartedLight.state.onOff.onOff, false);
  });
});
