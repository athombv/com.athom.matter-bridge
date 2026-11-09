import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Environment } from '@matter/main';
import MatterBridgeServer from '../lib/MatterBridgeServer.mjs';

const directory = mkdtempSync(join(tmpdir(), 'matter-bridge-lock-'));
after(async () => {
  await Environment.default.runtime.close();
  rmSync(directory, { recursive: true, force: true });
});

const api = {
  drivers: { connect: async () => {}, getDrivers: async () => ({}) },
  devices: { connect: async () => {}, getDevices: async () => ({}), on: () => {} },
};

function createServer(uniqueId, releaseStaleStorageLock) {
  return new MatterBridgeServer({
    api,
    debug: () => {},
    deviceName: 'Lock Test',
    vendorName: 'Athom B.V.',
    vendorId: 65521,
    productName: 'Lock Test',
    productId: 32768,
    uniqueId,
    serialNumber: `${uniqueId}-serial`,
    passcode: 20202021,
    discriminator: 3840,
    port: 0,
    storageServiceLocation: directory,
    releaseStaleStorageLock,
  });
}

// Simulates a process that was killed while holding the storage lock, whose PID
// looks alive to `process.kill(pid, 0)` (PID 1 is always alive; non-root gets EPERM).
function leaveStaleLock(uniqueId) {
  const nodeDirectory = join(directory, uniqueId);
  mkdirSync(nodeDirectory, { recursive: true });
  writeFileSync(join(nodeDirectory, 'matter.lock'), '');
  writeFileSync(join(nodeDirectory, 'matter.pid'), '1 0123456789abcdef');
  return nodeDirectory;
}

test('a stale storage lock from a killed process blocks startup without the release', { timeout: 30000 }, async () => {
  leaveStaleLock('locked-node');
  const server = createServer('locked-node', false);
  await assert.rejects(server.start(), /Storage is locked by another process \(pid 1\)/);
});

test('the Homey app releases a stale storage lock and starts', { timeout: 30000 }, async () => {
  const nodeDirectory = leaveStaleLock('released-node');
  const server = createServer('released-node', true);
  await server.start();
  assert.equal(server.serverNode.lifecycle.isOnline, true);
  await server.stop();
  assert.equal(existsSync(join(nodeDirectory, 'matter.lock')), false);
});
