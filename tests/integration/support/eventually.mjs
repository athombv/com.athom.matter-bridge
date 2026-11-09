import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function eventually(description, read, expected, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let actual;

  while (Date.now() < deadline) {
    actual = await read();

    if (actual === expected) {
      return;
    }

    await delay(100);
  }

  assert.equal(actual, expected, description);
}
