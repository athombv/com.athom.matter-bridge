'use strict';

const Homey = require('homey');
const profiles = require('./profiles.json');

class FixtureApp extends Homey.App {
  getState() {
    return { ready: true, profiles: Object.keys(profiles) };
  }

  getFixture(profile, id) {
    return this.homey.drivers.getDriver(profile).getDevice({ id });
  }
}

module.exports = FixtureApp;
