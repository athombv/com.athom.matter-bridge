import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mappings, backendReference } from './manifest.mjs';

export async function mappingCoverage() {
  const inventoryJson = await readFile(
    new URL('./backend-inventory.json', import.meta.url),
    'utf8',
  );
  const inventory = JSON.parse(inventoryJson);
  const official = JSON.parse(await readFile(
    new URL('../fixtures/official-capabilities.json', import.meta.url), 'utf8',
  ));
  assert.equal(official.backendRevision, backendReference.revision);

  assert.equal(inventory.revision, backendReference.revision);

  const covered = new Set();
  const ids = new Set();

  // Every declared fixture capability needs an independent behavioral contract.
  for (const fixture of mappings) {
    assert.ok(!ids.has(fixture.id), `Duplicate fixture ${fixture.id}`);
    ids.add(fixture.id);
    assert.ok(fixture.source, `Missing reference source for ${fixture.id}`);
    assert.ok(fixture.endpoints.length, `Missing endpoints for ${fixture.id}`);
    assert.ok(fixture.attributes.length, `Missing attributes for ${fixture.id}`);

    for (const id of Object.keys(fixture.capabilities)) {
      const base = id.split('.')[0];
      assert.ok(official.capabilities[base], `Non-official mapped capability ${fixture.id}/${id}`);
      const classifiedId = inventory.capabilities[id] ? id : base;
      assert.ok(inventory.capabilities[classifiedId], `Unclassified capability ${fixture.id}/${id}`);

      assert.equal(inventory.capabilities[classifiedId].status, 'supported', `Mapping status conflicts with fixture ${fixture.id}/${id}`);

      const checks = fixture.attributes.filter((attribute) => {
        return attribute.capabilityId === id;
      });

      assert.ok(checks.length, `Missing attribute contract for ${fixture.id}/${id}`);
      for (const check of checks) {
        assert.ok('initial' in check, `Missing initial value for ${fixture.id}/${id}`);
        assert.ok(check.updates.length, `Missing update tests for ${fixture.id}/${id}`);
      }

      if (fixture.capabilities[id].setable) {
        const commands = [...fixture.commands, ...(fixture.writes ?? [])];
        const hasCommand = commands.some((command) => {
          return id in command.writes;
        });

        assert.ok(hasCommand, `Missing command contract ${fixture.id}/${id}`);
      }

      covered.add(classifiedId);
    }
  }

  // Required variants prevent losing an entire mapping while retaining its capability elsewhere.
  for (const id of inventory.requiredVariants) {
    assert.ok(ids.has(id), `Required mapping variant removed: ${id}`);
  }

  const lines = [
    `Backend reference: ${inventory.revision}`,
    `${inventory.fixtureCount} saved backend device fixtures; not an exhaustive Homey capability catalog.`,
    `Official base provenance: homey-lib ${official.homeyLibVersion}, ${official.source}.`,
    `${mappings.length} bridge fixture variants covering ${covered.size} capabilities.`,
    '',
    '| Capability | Status | Evidence / follow-up |',
    '| --- | --- | --- |',
  ];

  for (const [id, entry] of Object.entries(inventory.capabilities)) {
    const isClassified = ['supported', 'missing', 'intentionally unsupported'].includes(
      entry.status,
    );

    assert.ok(isClassified, `Unclassified ${id}`);
    assert.ok(entry.reason, `Missing rationale for ${id}`);
    assert.ok(entry.source, `Missing provenance for ${id}`);

    if (entry.status === 'supported') {
      assert.ok(covered.has(id), `Supported mapping has no fixture: ${id}`);
    }

    lines.push(`| ${id} | ${entry.status} | ${entry.reason} Source: ${entry.source} |`);
  }

  lines.push(
    '',
    '## Feature follow-ups',
    '',
    '- Custom OnOff handlers currently advertise no feature bits. Lighting for light/plug endpoints and DeadFrontBehavior for room AC remain conformance follow-ups; basic on/off behavior is covered. Reference: Matter.js 0.17.9 device requirements and backend general/OnOffCluster.mts.',
    '- Continuous level/color movement, scenes, and timed lighting behaviors are not claimed by these capability contracts. Extend the command inventory before declaring them supported.',
  );

  return lines.join('\n');
}
