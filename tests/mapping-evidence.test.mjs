import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestEvidence } from './mappings/TestEvidence.mjs';
import { BackendComparison } from './mappings/BackendComparison.mjs';

const execute = promisify(execFile);

test('acceptance evidence rejects skipped, todo, missing and failing tests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mapping-evidence-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const file = join(directory, 'sample.mjs');
  await writeFile(file, `import { test } from 'node:test';
test('executed', () => {});
test('skipped', { skip: true }, () => { throw new Error('must not execute'); });
test('todo', { todo: true }, () => {});
test('unrelated failure', () => { throw new Error('unrelated assertion'); });
`);
  const driver = join(directory, 'driver.mjs');
  await writeFile(driver, `import { run } from 'node:test';
import { TestEvidence } from ${JSON.stringify(new URL('./mappings/TestEvidence.mjs', import.meta.url).href)};
const outcomes = [], failures = [];
for await (const event of run({ files: [${JSON.stringify(file)}] })) {
  if (event.type === 'test:pass' || event.type === 'test:fail') {
    const { name, skip, todo } = event.data;
    outcomes.push({ type: event.type, result: { name, skip, todo } });
  }
  if (event.type === 'test:fail') failures.push(TestEvidence.failure(event.data));
}
console.log(JSON.stringify({ outcomes, failures }));
`);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const { stdout } = await execute(process.execPath, [driver], { env: environment });
  const { outcomes, failures } = JSON.parse(stdout);
  const evidence = new TestEvidence();
  for (const { type, result } of outcomes) {
    evidence.record(type, result);
  }
  assert.equal(evidence.require('executed'), 'PASS');
  assert.equal(evidence.require('skipped'), 'SKIP');
  assert.equal(evidence.require('todo'), 'TODO');
  assert.equal(evidence.require('missing'), 'NOT RUN');
  assert.equal(evidence.failed, true);
  evidence.record('test:pass', { name: 'skipped' });
  assert.equal(evidence.require('skipped'), 'SKIP', 'A later same-name pass cannot erase missing coverage');

  const failedRun = { code: 1, signal: null, output: 'executed\nskipped\nunrelated assertion' };
  assert.equal(TestEvidence.detectsMutation(failedRun, { testName: 'executed' }, failures), false);
  assert.equal(TestEvidence.detectsMutation(failedRun, { evidence: 'executed' }, failures), false);
  assert.equal(TestEvidence.detectsMutation(failedRun, { testName: 'unrelated failure' }, failures), true);
  assert.equal(TestEvidence.detectsMutation(failedRun, { evidence: 'unrelated assertion' }, failures), true);
  assert.equal(TestEvidence.detectsMutation(failedRun, { testName: 'unrelated failure' }, [
    { name: 'unrelated failure', failureType: 'testTimeoutFailure', messages: ['unrelated assertion'] },
  ]), false);
  assert.equal(TestEvidence.detectsMutation({ code: null, signal: 'SIGKILL' }, { evidence: 'unrelated assertion' }, failures), false);
});

test('filtered acceptance reports fail before running or replacing full-report artifacts', async () => {
  await assert.rejects(execute(process.execPath, ['tests/mappings/report.mjs'], {
    env: { ...process.env, MAPPING_CASE: 'socket' },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /acceptance report requires every mapping/);
    return true;
  });
});

test('historical fixture generators refuse the current SDK without replacing evidence', async () => {
  for (const [script, fixture] of [
    ['generate-upgrade-fixture.mjs', 'mapping-upgrade.json'],
    ['generate-fan-upgrade-fixture.mjs', 'fan-policy-upgrade.json'],
  ]) {
    const url = new URL(`./fixtures/${fixture}`, import.meta.url);
    const before = await readFile(url);
    await assert.rejects(execute(process.execPath, [`tests/mappings/${script}`]), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Generate historical storage with Matter.js 0.17.9/);
      return true;
    });
    assert.deepEqual(await readFile(url), before);
  }
});

test('backend reverse control enforces the declared channel-specific quantization allowance', async () => {
  const source = {
    capabilitiesObj: { 'dim.secondary': { value: 0.5 } },
    writes: [],
    emit(id, value) { this.capabilitiesObj[id].value = value; },
  };
  const harness = { devices: { channel: source }, endpoint() { return 3; } };
  let error = 1 / 254;
  const rpc = {
    async call(method, args) {
      if (method === 'snapshot') {
        return [{ id: 'backend', capabilities: [{
          id: 'dim', endpointId: 3, clusterId: 8, value: source.capabilitiesObj['dim.secondary'].value,
        }] }];
      }
      source.writes.push({ capabilityId: 'dim.secondary', value: args.value + error });
    },
  };
  const fixture = {
    id: 'channel', capabilities: { 'dim.secondary': { value: 0.5, setable: true } },
    attributes: [{ capabilityId: 'dim.secondary', backendCapability: 'dim', cluster: 'LevelControl', name: 'currentLevel', updates: [] }],
  };
  const comparison = new BackendComparison(harness, rpc);
  await comparison.compare(fixture);
  error = 0.009;
  await assert.rejects(comparison.compare(fixture), /Backend requested 0.509/);
});
