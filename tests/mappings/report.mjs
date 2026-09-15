import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mappingCoverage } from './coverage.mjs';
import { mappings } from './manifest.mjs';

const results = new Map();
let failed = false;
const stream = run({
  files: [
    fileURLToPath(new URL('../mapping-behavior.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-inventory.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../mapping-infrastructure.test.mjs', import.meta.url)),
  ],
});
stream.on('test:pass', (result) => {
  results.set(result.name, 'PASS');
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

const directory = new URL('./artifacts/', import.meta.url);
await mkdir(directory, { recursive: true });

const summary = mappings.map((fixture) => {
  return `| ${fixture.id} | ${results.get(fixture.id) ?? 'NOT RUN'} |`;
});
const coverage = await mappingCoverage();
const report = [
  `# Mapping test report`,
  '',
  `Runtime: ${process.version}. Result: ${failed ? 'FAIL' : 'PASS'}.`,
  '',
  '| Variant | Result |',
  '| --- | --- |',
  ...summary,
  '',
  coverage,
  '',
].join('\n');
await writeFile(new URL('report.md', directory), report);
console.log(`Report: ${fileURLToPath(new URL('report.md', directory))}`);
process.exitCode = failed ? 1 : 0;
