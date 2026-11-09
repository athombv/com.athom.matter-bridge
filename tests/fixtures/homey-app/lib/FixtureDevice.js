'use strict';

const Homey = require('homey');
const profiles = require('../profiles.json');

class FixtureDevice extends Homey.Device {
  async onInit() {
    this.initialized = false;
    this.commandLog = [];
    this.rejectedCapabilities = new Set();
    const profile = profiles[this.driver.manifest.id];

    for (const capability of Object.keys(profile.commands)) {
      this.registerCapabilityListener(capability, async (value) => {
        const accepted = !this.rejectedCapabilities.has(capability);
        this.commandLog.push({ capability, value, accepted });
        this.commandLog = this.commandLog.slice(-100);

        if (!accepted) {
          throw new Error(`Simulated rejection: ${capability}`);
        }

        // Simulate the device acknowledging and reporting a successful command.
        await this.setCapabilityValue(capability, value);
      });
    }

    if (!this.getStoreValue('initialized')) {
      await this.report(profile.values);
      await this.setStoreValue('initialized', true);
    }

    await this.setAvailable();
    this.initialized = true;
  }

  async report(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('Report values must be an object');
    }

    for (const capability of Object.keys(values)) {
      if (!this.hasCapability(capability)) {
        throw new Error(`Unknown capability: ${capability}`);
      }
    }

    for (const [capability, value] of Object.entries(values)) {
      await this.setCapabilityValue(capability, value);
    }
  }

  async control(body) {
    switch (body.operation) {
      case 'report':
        await this.report(body.values);
        break;
      case 'availability':
        if (typeof body.available !== 'boolean') {
          throw new Error('Availability must be a boolean');
        }

        if (body.available) {
          await this.setAvailable();
        } else {
          await this.setUnavailable('Simulated offline device');
        }
        break;
      case 'reject': {
        const profile = profiles[this.driver.manifest.id];

        if (profile.commands[body.capability] === undefined) {
          throw new Error(`Not a command capability: ${body.capability}`);
        }

        if (typeof body.rejected !== 'boolean') {
          throw new Error('Rejection must be a boolean');
        }

        if (body.rejected) {
          this.rejectedCapabilities.add(body.capability);
        } else {
          this.rejectedCapabilities.delete(body.capability);
        }
        break;
      }
      case 'clear-commands':
        this.commandLog = [];
        break;
      default:
        throw new Error(`Unknown control operation: ${body.operation}`);
    }

    return this.snapshot();
  }

  snapshot() {
    const values = {};

    for (const capability of this.getCapabilities()) {
      values[capability] = this.getCapabilityValue(capability);
    }

    return {
      initialized: this.initialized === true,
      available: this.getAvailable(),
      values,
      commands: this.commandLog ?? [],
    };
  }
}

module.exports = { FixtureDevice };
