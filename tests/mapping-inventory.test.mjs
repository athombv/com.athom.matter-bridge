import { test } from 'node:test';
import { mappingCoverage } from './mappings/coverage.mjs';

test('mapping inventory classifies capabilities and requires behavioral contracts', async (t) => {
  t.diagnostic(await mappingCoverage());
});
