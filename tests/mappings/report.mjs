import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mappingCoverage } from './coverage.mjs';
import { mappings } from './manifest.mjs';

const directory = new URL('./artifacts/', import.meta.url);
const surfaceFile = new URL('surface.json', directory);
await mkdir(directory, { recursive: true });
await rm(surfaceFile, { force: true });

const results = new Map();
let failed = false;
const stream = run({
  files: [
    fileURLToPath(new URL('../mapping-behavior.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-inventory.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-infrastructure.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-upgrade.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-names.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-availability.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-discovery.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-fan.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-channels.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-light-controls.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-power.test.mjs', import.meta.url)),
  ],
});
stream.on('test:pass', (result) => {
  if (results.get(result.name) !== 'FAIL') {
    results.set(result.name, 'PASS');
  }
});
stream.on('test:fail', (result) => {
  results.set(result.name, 'FAIL');
  failed = true;
});
stream.compose(spec).pipe(process.stdout);
await new Promise((resolve, reject) => {
  stream.on('end', resolve);
  stream.on('error', reject);
});

const summary = mappings.map((fixture) => {
  return `| ${fixture.id} | ${results.get(fixture.id) ?? 'NOT RUN'} |`;
});
const coverage = await mappingCoverage();
let surface = { counts: {}, entries: [] };
try {
  surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
  failed = true;
}
const phases = [
  'bridge mapping contracts through a Matter controller',
  'every mapping restores current Homey state with an existing pairing',
  'previous release storage upgrades every mapping without pairing again',
  'Homey renames reach the controller without replacing the device',
  'restart refreshes a persisted Matter name from Homey',
  'names follow Homey through delayed readiness and disable/re-enable',
  'unknown boolean readings stay unavailable until a known reading arrives',
  'mixed water sensors follow source availability without inventing readings',
  'bulk additions expose complete descriptors and working subscriptions',
  'existing on/off fan upgrades in place and handles official speed, off and unknown readings',
  'removing custom speed preserves a paired fan on/off endpoint',
  'independent light channels route full capability IDs and retain identity after restart',
  'energy and battery additions preserve existing socket endpoints and pairing',
  'battery percentage clamps limits without turning unknown into zero',
].map((name) => {
  return `| ${name} | ${results.get(name) ?? 'NOT RUN'} |`;
});
const surfaceRows = surface.entries.map((entry) => {
  return `| ${entry.cluster}.${entry.name} | ${entry.kind} | ${entry.status} | ${entry.reason} |`;
});
const report = [
  `# Mapping test report`,
  '',
  `Runtime: ${process.version}. Result: ${failed ? 'FAIL' : 'PASS'}.`,
  '',
  '| Phase | Result |',
  '| --- | --- |',
  ...phases,
  '',
  '| Variant | Result |',
  '| --- | --- |',
  ...summary,
  '',
  coverage,
  '',
  '## Advertised Matter surface',
  '',
  'Classifications describe coverage responsibilities. Delegated behavior and explicit gaps are not counted as independently tested. Physical controller checks remain a separate release gate.',
  '',
  `Observed members: ${surface.counts.tested ?? 0} tested, ${surface.counts.delegated ?? 0} delegated, ${surface.counts.gap ?? 0} gaps. An empty inventory means the surface audit did not complete.`,
  '',
  '| Member | Kind | Classification | Evidence / limitation |',
  '| --- | --- | --- | --- |',
  ...surfaceRows,
  '',
].join('\n');
await writeFile(new URL('report.md', directory), report);
console.log(`Report: ${fileURLToPath(new URL('report.md', directory))}`);
process.exitCode = failed ? 1 : 0;
