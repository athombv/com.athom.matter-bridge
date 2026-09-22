import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mappingCoverage } from './mappings/coverage.mjs';
import { BackendComparison } from './mappings/BackendComparison.mjs';
import { mappings } from './mappings/manifest.mjs';

test('mapping inventory classifies capabilities and requires behavioral contracts', async (t) => {
  t.diagnostic(await mappingCoverage());
});

test('backend report preserves allowance provenance for independent capability channels', async () => {
  const allowances = JSON.parse(await readFile(
    new URL('./mappings/backend-allowances.json', import.meta.url), 'utf8',
  ));
  const expected = new Map([
    ['sub-light-extended-color', ['matter-quantization', 'color-temperature-quantization']],
    ['sub-measure_voltage', ['electrical-display-precision']],
    ['sub-measure_current', ['electrical-display-precision']],
    ['sub-alarm_occupancy', ['ultrasonic-occupancy-name']],
    ['sub-fan-speed', ['fan-percentage-quantization']],
    ['sub-measure_pm1', []],
    ['sub-hvac', ['homey-measurement-precision']],
    ['thermostat-off-cool-separate', ['homey-measurement-precision', 'mode-dependent-target']],
  ]);

  for (const [id, ids] of expected) {
    const fixture = mappings.find((item) => {
      return item.id === id;
    });

    assert.ok(fixture, `Missing mapping ${id}`);
    assert.deepEqual(BackendComparison.applicableAllowances(fixture, allowances), ids, id);
  }
});
