import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { PairingPanel } from '../settings/pairing.mjs';

function fixture(t, state, api = async () => { return state; }) {
  const dom = new JSDOM('<div id="panel"></div><input id="device" type="checkbox" checked>');
  const container = dom.window.document.querySelector('#panel');
  const codes = [];
  class QRCode {
    static CorrectLevel = { H: 2 };
    constructor(element, { text }) {
      codes.push(text);
      element.textContent = text;
    }
  }
  globalThis.QRCode = QRCode;
  t.after(() => { delete globalThis.QRCode; });
  const Homey = { api, alert: async () => {} };
  let reloads = 0;
  const panel = new PairingPanel({ Homey, container, onCommissionedChanged: () => { reloads += 1; } });
  panel.update(state);
  t.after(() => { panel.dispose(); dom.window.close(); });
  return { panel, container, codes, dom, reloads: () => { return reloads; } };
}

function state(status, expiresAt = Date.now() + 300000) {
  return {
    commissioned: true,
    pairing: {
      status,
      expiresAt,
      qrPairingCode: status === 'open' ? 'MT:temporary' : null,
      manualPairingCode: status === 'open' ? '12345678901' : null,
    },
  };
}

test('refresh restores the active code without rebuilding device selections', (t) => {
  const { panel, dom, codes } = fixture(t, state('open'));
  assert.equal(panel.qr.hidden, false);
  assert.equal(panel.stopButton.hidden, false);
  assert.match(panel.countdown.textContent, /5:00/);
  panel.update(state('open'));
  assert.equal(codes.length, 1);
  assert.equal(dom.window.document.querySelector('#device').checked, true);
  panel.update(state('completed'));
  assert.equal(panel.qr.hidden, true);
  assert.equal(panel.code.textContent, '');
  assert.equal(panel.qrImage.textContent, '');
  assert.match(panel.message.textContent, /Platform connected/);
});

test('countdown removes expired codes even before the next server response', (t) => {
  const expiresAt = Date.now() + 1000;
  const { panel } = fixture(t, state('open', expiresAt));
  t.mock.method(Date, 'now', () => { return expiresAt + 1; });
  panel.render();
  assert.equal(panel.qr.hidden, true);
  assert.equal(panel.code.textContent, '');
  assert.equal(panel.countdown.textContent, 'Finishing pairing…');
  panel.update(state('expired'));
  assert.equal(panel.startButton.disabled, false);
});

test('requests do not overlap and failures restore the controls', async (t) => {
  let rejectRequest;
  let calls = 0;
  const { panel } = fixture(t, state('idle'), () => {
    calls += 1;
    return new Promise((resolve, reject) => { rejectRequest = reject; });
  });
  const pending = panel.request('POST', '/pairing/start');
  assert.equal(panel.startButton.disabled, true);
  await panel.request('GET', '/state');
  assert.equal(calls, 1);
  rejectRequest(new Error('Offline'));
  await assert.rejects(pending, /Offline/);
  assert.equal(panel.startButton.disabled, false);
  panel.showError(new Error('Offline'));
  assert.equal(panel.error.hidden, false);
  assert.equal(panel.error.textContent, 'Offline');
});

test('copy failure offers manual copying; stopped and external windows have no code', async (t) => {
  const { panel } = fixture(t, state('open'));
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error('Denied'); } } },
  });
  t.after(() => { Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); });
  await assert.rejects(panel.copyCode(), /copy it manually/);
  panel.update(state('cancelled'));
  assert.equal(panel.stopButton.hidden, true);
  panel.update(state('external'));
  assert.equal(panel.qr.hidden, true);
  assert.equal(panel.startButton.disabled, true);
});

test('initial setup remains visible and completion reloads the device list once', (t) => {
  const { panel, reloads } = fixture(t, {
    commissioned: false, qrPairingCode: 'MT:initial', manualPairingCode: '12345678901', pairing: null,
  });
  assert.equal(panel.qr.hidden, false);
  assert.equal(panel.startButton.hidden, true);
  panel.update(state('idle'));
  panel.update(state('idle'));
  assert.equal(reloads(), 1);
});

test('leaving settings stops polling without closing pairing', async (t) => {
  const requests = [];
  const { panel } = fixture(t, state('open'), async (method, path) => {
    requests.push(path);
    return state('open');
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  panel.start();
  t.mock.timers.tick(2000);
  await Promise.resolve();
  assert.deepEqual(requests, ['/state']);
  panel.dispose();
  t.mock.timers.tick(4000);
  assert.deepEqual(requests, ['/state']);
});
