import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { access, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { BridgeHarness } from './BridgeHarness.mjs';
import { Rpc } from './Rpc.mjs';
import { BridgeTransport } from './BridgeTransport.mjs';
import { BackendComparison } from './BackendComparison.mjs';
import { selectMappings } from './selectMappings.mjs';
import { mappings, backendReference } from './manifest.mjs';

const { values } = parseArgs({
  options: {
    'backend-path': { type: 'string' },
    'backend-node': { type: 'string' },
    'allow-backend-revision-mismatch': { type: 'boolean', default: false },
  },
});

assert.ok(
  values['backend-path'],
  'Provide --backend-path pointing to an installed node-homey-os checkout',
);

assert.ok(values['backend-node'], 'Provide --backend-node pointing to a Node 24 executable');

const backendPath = resolve(values['backend-path']);

try {
  await access(resolve(backendPath, 'node_modules/@athombv/homey-matter'));
} catch (cause) {
  throw new Error(
    'Backend dependencies are missing. Install dependencies in the node-homey-os checkout using its documented setup, then retry.',
    { cause },
  );
}
const nodeVersion = execFileSync(values['backend-node'], ['--version'], {
  encoding: 'utf8',
}).trim();

assert.match(nodeVersion, /^v24\./, 'The backend adapter requires Node 24');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: backendPath,
  encoding: 'utf8',
}).trim();

if (!values['allow-backend-revision-mismatch']) {
  assert.equal(
    revision,
    backendReference.revision,
    'Backend revision differs; use the pinned checkout or explicitly pass --allow-backend-revision-mismatch',
  );
}
const changes = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
  cwd: backendPath,
  encoding: 'utf8',
}).trim();

if (!values['allow-backend-revision-mismatch']) {
  assert.equal(changes, '', 'Pinned backend comparison requires an unmodified tracked checkout');
}
console.log(
  `Backend ${revision}${changes ? ' (modified)' : ''} (${nodeVersion}); bridge ${process.version}`,
);
// Reference files are independent reads; validate them after all reads finish.
const [inventoryJson, allowancesJson, extensionsJson] = await Promise.all([
  readFile(new URL('./backend-inventory.json', import.meta.url), 'utf8'),
  readFile(new URL('./backend-allowances.json', import.meta.url), 'utf8'),
  readFile(new URL('../fixtures/homey-os-capabilities.json', import.meta.url), 'utf8'),
]);
const inventory = JSON.parse(inventoryJson);
const allowances = JSON.parse(allowancesJson);
const extensions = JSON.parse(extensionsJson);
assert.equal(extensions.backendRevision, backendReference.revision);
const backendRequire = createRequire(resolve(backendPath, 'packages/homey-local/package.json'));
const homeyLibPath = dirname(backendRequire.resolve('homey-lib/package.json'));
const officialFiles = await readdir(resolve(homeyLibPath, 'assets/capability/capabilities'));
const officialBases = new Set(officialFiles.map((file) => {
  return file.replace(/\.json$/, '');
}));

// Explicitly verified Homey OS extensions are eligible alongside homey-lib capabilities.
for (const [id, entry] of Object.entries(inventory.capabilities)) {
  const base = id.split('.')[0];
  const isKnownCapability = officialBases.has(base) || extensions.capabilities[base] !== undefined;

  if (!isKnownCapability) {
    assert.equal(entry.status, 'intentionally unsupported', `Unverified backend capability ${id}`);
  }
}

const assets = resolve(backendPath, backendReference.fixtures);
const files = (await readdir(assets)).filter((file) => {
  return file.endsWith('.output.json');
});

assert.equal(files.length, inventory.fixtureCount, 'Backend fixture count changed; refresh the mapping inventory');

for (const file of files) {
  const fixtureJson = await readFile(resolve(assets, file), 'utf8');
  const fixture = JSON.parse(fixtureJson);

  for (const device of fixture.devices ?? []) {
    for (const id of device.capabilities ?? []) {
      const normalized = id.replace(/[.-]matter-\d+-\d+$/, '');
      assert.ok(
        inventory.capabilities[normalized],
        `Unclassified backend capability ${id} in ${file}`,
      );
    }
  }
}

const selected = selectMappings(mappings, process.env.MAPPING_CASE);
const harness = await BridgeHarness.create(selected);
let worker;
let rpc;
const mismatches = [];
const results = [];

try {
  worker = fork(fileURLToPath(new URL('./backend-worker.mjs', import.meta.url)), [backendPath], {
    execPath: values['backend-node'],
    execArgv: ['--conditions=typescript'],
    cwd: resolve(backendPath, 'packages/homey-local'),
    env: { ...process.env, ALLOW_DEVTOKEN: '1', TMPDIR: harness.directory },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  await waitForBackend(worker);

  const transport = new BridgeTransport(harness);
  rpc = new Rpc(worker, async (method, args) => {
    return await transport.handle(method, args);
  });
  harness.onReport = async (report) => {
    await transport.forwardReport(report);
  };

  const discovered = await rpc.call('init');
  transport.subscribe(rpc, discovered.paths);
  const comparison = new BackendComparison(harness, rpc);
  if (process.env.MAPPING_DEBUG) {
    console.log(JSON.stringify(discovered, null, 2));
  }

  for (const fixture of selected) {
    try {
      await comparison.compare(fixture);
      const applicableAllowances = BackendComparison.applicableAllowances(fixture, allowances);

      results.push({ id: fixture.id, status: 'PASS', allowances: applicableAllowances });
      console.log(`PASS ${fixture.id}: backend discovery, values, updates and controls`);
    } catch (error) {
      mismatches.push(fixture.id);
      results.push({ id: fixture.id, status: 'FAIL', error: error.message });
      console.error(`FAIL ${fixture.id}:`, error);
    }
  }
  await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('./artifacts/backend.json', import.meta.url),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        revision,
        modified: !!changes,
        backendNode: nodeVersion,
        bridgeNode: process.version,
        allowances,
        results,
      },
      null,
      2,
    ) + '\n',
  );
  assert.deepEqual(mismatches, [], 'Unexplained backend mapping differences');
} finally {
  harness.onReport = undefined;
  try {
    if (rpc && worker.connected) {
      await rpc.call('close');
    }
  } finally {
    try {
      await stopWorker(worker);
    } finally {
      await harness.close();
    }
  }
}

async function waitForBackend(worker) {
  let logs = '';
  const capture = (data) => {
    logs = (logs + data).slice(-12000);
  };
  worker.stdout.on('data', capture);
  worker.stderr.on('data', capture);

  let timer;
  let ready;
  let exited;
  let failed;

  try {
    await new Promise((resolve, reject) => {
      ready = (message) => {
        if (message.ready === true) {
          resolve();
        }
      };
      exited = (code) => {
        reject(
          new Error(`Backend failed to load (${code}); install its dependencies first.\n${logs}`),
        );
      };
      failed = (cause) => {
        reject(new Error('Could not start the backend worker', { cause }));
      };
      worker.on('message', ready);
      worker.once('exit', exited);
      worker.once('error', failed);
      timer = setTimeout(() => {
        reject(new Error(`Backend load timed out\n${logs}`));
      }, 30000);
    });
  } finally {
    clearTimeout(timer);
    worker.off('message', ready);
    worker.off('exit', exited);
    worker.off('error', failed);
    worker.stdout.off('data', capture);
    worker.stderr.off('data', capture);
    // Keep draining diagnostic pipes while the worker runs.
    worker.stdout.resume();
    worker.stderr.resume();
  }
}

async function stopWorker(worker) {
  if (!worker) {
    return;
  }
  if (worker.connected) {
    worker.disconnect();
  }
  if (worker.exitCode !== null || worker.signalCode !== null) {
    return;
  }

  const exitPromise = once(worker, 'exit');
  worker.kill();
  const timer = setTimeout(() => {
    worker.kill('SIGKILL');
  }, 5000);

  try {
    await exitPromise;
  } finally {
    clearTimeout(timer);
  }
}
