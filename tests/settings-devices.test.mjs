import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { DevicesPanel } from '../settings/devices.mjs';

const html = await readFile(new URL('../settings/index.html', import.meta.url), 'utf8');

function setup(t, devices) {
  const dom = new JSDOM(html.replace(/<style[\s\S]*?<\/style>/g, ''));
  t.after(() => {
    dom.window.close();
  });
  const document = dom.window.document;
  const writes = [];
  const Homey = {
    api: async (...args) => {
      writes.push(args);
    },
    error: assert.fail,
  };
  const panel = new DevicesPanel({
    Homey,
    container: document.querySelector('#devices-content'),
    selectedCount: document.querySelector('#selected-count'),
    template: document.querySelector('#template-device'),
  });
  panel.render(devices);
  return { panel, Homey, document, writes };
}

const unsupported = {
  id: 'unsupported-camera', name: 'Camera', isSelected: false,
  support: {
    canShare: false, supportedCapabilities: [],
    unsupportedCapabilities: [{ id: 'alarm_generic', title: 'Alarm' }],
  },
};
const partial = {
  id: 'partial-fan', name: 'Fan', zoneName: 'Room', isSelected: false,
  support: {
    canShare: true, supportedCapabilities: [{ id: 'onoff', title: 'On/off' }],
    unsupportedCapabilities: [{ id: 'fan_speed', title: 'Fan speed' }],
  },
};

test('unsupported devices are explained and cannot be newly selected', (t) => {
  const { document } = setup(t, [structuredClone(unsupported)]);
  assert.equal(document.querySelector('.device input').disabled, true);
  assert.match(document.querySelector('.device-support').textContent, /No supported capabilities/);
  assert.match(document.querySelector('.device-support').textContent, /Not shared: Alarm/);
  assert.equal(document.querySelector('.zone-name').textContent, 'Other');
});

test('existing unsupported selections can be removed', async (t) => {
  const device = { ...structuredClone(unsupported), isSelected: true };
  const { panel, document, writes } = setup(t, [device]);
  const input = document.querySelector('.device input');
  assert.equal(input.disabled, false);
  assert.equal(input.checked, true);
  input.checked = false;
  await panel.updateDeviceSelection(device, input);
  assert.deepEqual(writes, [['POST', '/devices/disable', { deviceId: device.id }]]);
  assert.equal(input.disabled, true);
  assert.equal(document.querySelector('#selected-count').textContent, '0 selected');
});

test('partial support is visible and a rejected selection restores the previous state', async (t) => {
  const device = structuredClone(partial);
  const { panel, Homey, document } = setup(t, [device]);
  const input = document.querySelector('.device input');
  assert.match(document.querySelector('.device-support').textContent, /Shared: On\/off/);
  assert.match(document.querySelector('.device-support').textContent, /Not shared: Fan speed/);
  Homey.api = async () => {
    throw new Error('Device initialization failed');
  };
  input.checked = true;
  await assert.rejects(panel.updateDeviceSelection(device, input), /initialization failed/);
  assert.equal(input.checked, false);
  assert.equal(input.disabled, false);
  assert.equal(device.isSelected, false);
});

test('successful selections wait for the API and render source text safely', async (t) => {
  const device = structuredClone(partial);
  device.name = '<img src=x onerror=alert(1)>';
  device.support.unsupportedCapabilities[0].title = '<script>source title</script>';
  const { panel, Homey, document } = setup(t, [device]);
  let finish;
  Homey.api = () => {
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const input = document.querySelector('.device input');
  input.checked = true;
  const pending = panel.updateDeviceSelection(device, input);
  assert.equal(input.disabled, true);
  assert.equal(device.isSelected, false);
  finish();
  await pending;
  assert.equal(device.isSelected, true);
  assert.equal(document.querySelector('#selected-count').textContent, '1 selected');
  assert.equal(document.querySelector('.device-card img, .device-card script'), null);
  assert.equal(document.querySelector('[data-template-device-name]').textContent, device.name);
});
