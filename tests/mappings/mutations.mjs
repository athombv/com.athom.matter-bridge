import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = fileURLToPath(new URL('./artifacts/', import.meta.url));
await mkdir(artifacts, { recursive: true });
await rm(join(artifacts, 'mutations.json'), { force: true });
const mutations = [
  {
    id: 'unclassified-advertised-attribute',
    mapping: 'socket',
    removeAttribute: true,
    evidence: 'Unclassified advertised attribute',
  },
  {
    id: 'removed-command-contract',
    mapping: 'socket',
    file: 'tests/mappings/manifest.mjs',
    from: "  command('OnOff', 'off', {}, { onoff: false }),",
    to: '',
    evidence: 'Declared tested command has no contract',
  },
  {
    id: 'wrong-power-unit',
    mapping: 'socket',
    from: 'Math.round(value * 1000)',
    to: 'Math.round(value)',
    evidence: 'socket/measure_power initial',
  },
  {
    id: 'inverted-lock',
    mapping: 'lock-true',
    from: 'return value ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked;',
    to: 'return value ? DoorLock.LockState.Unlocked : DoorLock.LockState.Locked;',
    evidence: 'lock-true/locked initial',
  },
  {
    id: 'fractional-setpoint-loss',
    mapping: 'thermostat-off-heat',
    from: 'thermostat.occupiedHeatingSetpoint = Math.round(value * 100);',
    to: 'thermostat.occupiedHeatingSetpoint = Math.round(value) * 100;',
    evidence: 'target_temperature initial',
  },
  {
    id: 'missing-subscription-update',
    mapping: 'socket',
    from: 'await callback(...props);',
    to: 'return;',
    evidence: 'Subscription',
  },
  {
    id: 'stale-restored-state',
    mapping: 'socket',
    suite: 'mapping-upgrade.test.mjs',
    from: 'await update();',
    to: 'continue;',
    evidence: 'after offline source change',
  },
  {
    id: 'conflicting-color-mode',
    mapping: 'light-extended-temperature',
    from: 'this.state.enhancedColorMode = endpointProperties.colorControl.enhancedColorMode;',
    to: 'this.state.enhancedColorMode = 1;',
    evidence: 'Color mode attributes must agree',
    also: [
      'enhancedColorMode: ColorControl.EnhancedColorMode.ColorTemperatureMireds,',
      'enhancedColorMode: 1,',
    ],
  },
];
const results = [];
for (const mutation of mutations) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-mutation-'));
  try {
    await cp(join(root, 'lib'), join(directory, 'lib'), { recursive: true });
    await cp(join(root, 'tests'), join(directory, 'tests'), {
      recursive: true,
      filter: (path) => {
        return !path.includes('/artifacts');
      },
    });
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    if (mutation.removeAttribute) {
      const path = join(directory, 'tests/mappings/matter-surface.json');
      const catalog = JSON.parse(await readFile(path, 'utf8'));
      delete catalog.clusters.ElectricalPowerMeasurement.attributes['0'];
      await writeFile(path, JSON.stringify(catalog));
    } else {
      const server = join(directory, mutation.file ?? 'lib/MatterBridgeServer.mjs');
      let source = await readFile(server, 'utf8');
      assert.ok(source.includes(mutation.from), `Mutation target moved: ${mutation.id}`);
      source = source.replaceAll(mutation.from, mutation.to);
      if (mutation.also) {
        assert.ok(source.includes(mutation.also[0]), `Mutation target moved: ${mutation.id}`);
        source = source.replaceAll(...mutation.also);
      }
      await writeFile(server, source);
    }

    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--test', join(directory, 'tests', mutation.suite ?? 'mapping-behavior.test.mjs')],
        {
          cwd: directory,
          env: { ...process.env, MAPPING_CASE: mutation.mapping },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      const capture = (chunk) => {
        output += chunk;
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 120000);
      child.on('error', (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, output });
      });
    });
    const detected =
      result.code === 1 && result.signal === null && result.output.includes(mutation.evidence);
    await writeFile(join(artifacts, `mutation-${mutation.id}.log`), result.output);
    results.push({ id: mutation.id, detected, evidence: mutation.evidence });
    console.log(`${detected ? 'DETECTED' : 'NOT DETECTED'} ${mutation.id}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
await writeFile(
  join(artifacts, 'mutations.json'),
  JSON.stringify(
    { runtime: process.version, completedAt: new Date().toISOString(), results },
    null,
    2,
  ) + '\n',
);
assert.ok(
  results.every((result) => {
    return result.detected;
  }),
  'Mutation checks did not detect every seeded defect',
);
