// These become real SHS devices via its native virtual driver and pairing API.
export const deviceTypes = {
  light: { class: 'light', capabilities: ['onoff', 'dim'], values: { onoff: false, dim: 0.5 } },
  socket: { class: 'socket', capabilities: ['onoff'], values: { onoff: false } },
};
