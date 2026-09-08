import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { SettingsTabs } from '../settings/tabs.mjs';

const html = await readFile(new URL('../settings/index.html', import.meta.url), 'utf8');

function fixture(t, state) {
  // Browser checks cover CSS; jsdom does not parse the existing nested tile rules.
  const dom = new JSDOM(html.replace(/<style[\s\S]*?<\/style>/g, ''));
  t.after(() => { dom.window.close(); });
  const document = dom.window.document;
  const tabs = new SettingsTabs(document.querySelector('#content'));
  tabs.initialize(state);
  return { dom, document, tabs, devices: tabs.tabs[0], pairing: tabs.tabs[1] };
}

test('initial setup disables Devices and opens Pairing', (t) => {
  const { document, devices, pairing } = fixture(t, { commissioned: false });
  assert.equal(devices.disabled, true);
  devices.click();
  assert.equal(pairing.getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelector('#devices-panel').hidden, true);
  assert.equal(document.querySelector('#pairing-panel').hidden, false);
});

test('paired users see Devices, but refreshing an active attempt restores Pairing', (t) => {
  const { tabs, devices, pairing } = fixture(t, { commissioned: true, pairing: { status: 'idle' } });
  assert.equal(devices.disabled, false);
  assert.equal(devices.getAttribute('aria-selected'), 'true');
  for (const status of ['open', 'external', 'busy']) {
    tabs.initialize({ commissioned: true, pairing: { status } });
    assert.equal(pairing.getAttribute('aria-selected'), 'true');
  }
});

test('switching tabs preserves the mounted device selections and supports keyboard navigation', (t) => {
  const { dom, document, devices, pairing } = fixture(t, { commissioned: true });
  const tile = document.querySelector('#template-device').content.cloneNode(true);
  const input = tile.querySelector('input');
  input.checked = true;
  document.querySelector('#devices-content').appendChild(tile);

  pairing.click();
  assert.equal(document.querySelector('#devices-panel').hidden, true);
  assert.equal(input.isConnected, true);
  assert.equal(input.checked, true);
  pairing.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(document.activeElement, devices);
  assert.equal(devices.tabIndex, 0);
  assert.equal(pairing.tabIndex, -1);
  assert.equal(document.querySelector('#devices-panel').hidden, false);
  assert.equal(document.querySelector('#devices-content input'), input);
});
