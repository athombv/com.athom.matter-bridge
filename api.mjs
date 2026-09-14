export default {
  startPairing: async ({ homey }) => {
    return await homey.app.onAPIStartPairing();
  },
  stopPairing: async ({ homey }) => {
    return await homey.app.onAPIStopPairing();
  },
  getState: async ({ homey }) => {
    return homey.app.onAPIGetState();
  },
  getDevices: async ({ homey }) => {
    return homey.app.onAPIGetDevices();
  },
  enableDevice: async ({ homey, body }) => {
    return homey.app.onAPIEnableDevice({ deviceId: body.deviceId });
  },
  disableDevice: async ({ homey, body }) => {
    return homey.app.onAPIDisableDevice({ deviceId: body.deviceId });
  }
};
