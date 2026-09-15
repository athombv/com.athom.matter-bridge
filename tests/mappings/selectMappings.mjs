import assert from 'node:assert/strict';

export function selectMappings(mappings, filter) {
  if (!filter) {
    return mappings;
  }

  const requested = filter.split(',');
  const available = new Set(
    mappings.map((fixture) => {
      return fixture.id;
    }),
  );

  for (const id of requested) {
    assert.ok(available.has(id), `Unknown MAPPING_CASE: ${id}`);
  }

  return mappings.filter((fixture) => {
    return requested.includes(fixture.id);
  });
}
