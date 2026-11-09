'use strict';

const { randomUUID } = require('node:crypto');
const Homey = require('homey');
const { FixtureDevice } = require('./FixtureDevice');

class FixtureDriver extends Homey.Driver {
  onMapDeviceClass() {
    return FixtureDevice;
  }

  async onPairListDevices() {
    return [{ name: this.manifest.name.en, data: { id: randomUUID() } }];
  }
}

module.exports = { FixtureDriver };
