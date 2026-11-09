'use strict';

module.exports = {
  async getState({ homey }) {
    return homey.app.getState();
  },
  async getDevice({ homey, params }) {
    return homey.app.getFixture(params.profile, params.id).snapshot();
  },
  async controlDevice({ homey, params, body }) {
    return await homey.app.getFixture(params.profile, params.id).control(body);
  },
};
