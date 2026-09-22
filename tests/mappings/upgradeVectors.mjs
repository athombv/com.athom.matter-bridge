import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

// Use explicit contract vectors; never calculate expectations with bridge conversions.
export function upgradeVectors(fixture) {
  const values = {};
  const attributes = [];

  for (const [capabilityId, capability] of Object.entries(fixture.capabilities)) {
    const contract = fixture.attributes.find((attribute) => {
      return attribute.capabilityId === capabilityId;
    });
    const update = contract.updates.find(([value]) => {
      return value !== null && !isDeepStrictEqual(value, capability.value);
    });
    assert.ok(update, `No changed upgrade vector for ${fixture.id}/${capabilityId}`);
    values[capabilityId] = update[0];
  }

  for (const attribute of fixture.attributes) {
    const update = attribute.updates.find(([value]) => {
      return isDeepStrictEqual(value, values[attribute.capabilityId]);
    });
    assert.ok(update, `No upgrade expectation for ${fixture.id}/${attribute.name}`);
    const expected = values[fixture.capabilitySuffix ? `onoff.${fixture.capabilitySuffix}` : 'onoff'] === false && 'valueWhenOff' in attribute
      ? attribute.valueWhenOff
      : update[1];
    attributes.push({ ...attribute, expected });
  }

  return { values, attributes };
}
