import assert from 'node:assert/strict';

export class SimulatedDevice {
  constructor(fixture) {
    this.id = fixture.id;
    this.name = fixture.id;
    this.class = fixture.class;
    this.virtualClass = fixture.virtualClass;
    this.ready = fixture.ready ?? true;
    this.capabilitiesObj = structuredClone(fixture.capabilities);
    this.capabilities = Object.keys(this.capabilitiesObj);
    this.listeners = new Map();
    this.writes = [];
    this.rejectWrites = false;
    this.attempts = 0;
  }

  async getDriver() {
    return { name: 'Synthetic mapping fixture', ownerName: 'Test' };
  }

  makeCapabilityInstance(id, callback) {
    const listeners = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, listeners);
    listeners.add(callback);

    return {
      destroy: () => {
        listeners.delete(callback);
      },
    };
  }

  async setCapabilityValue(write) {
    this.attempts++;

    if (this.rejectWrites) {
      throw new Error('Simulated Homey command rejection');
    }
    assert.ok(this.capabilitiesObj[write.capabilityId], `Unknown capability ${write.capabilityId}`);
    this.writes.push(write);

    // A driver reports state asynchronously after accepting a command.
    setImmediate(() => {
      this.emit(write.capabilityId, write.value);
    });
  }

  emit(id, value) {
    this.capabilitiesObj[id].value = value;

    for (const listener of this.listeners.get(id) ?? []) {
      listener(value);
    }
  }
}
