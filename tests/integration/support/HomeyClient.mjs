import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { HomeyAPI } from 'homey-api';
import { APP_ID, FIXTURE_APP_ID, TEST_PASSWORD, TEST_USERNAME } from '../../../scripts/integration/config.mjs';
import { eventually } from './eventually.mjs';
import profiles from '../../fixtures/homey-app/profiles.json' with { type: 'json' };

export class HomeyClient {
  #token;

  constructor() {
    // Runs inside the disposable SHS network namespace. No real-Homey URL override.
    this.baseUrl = 'http://127.0.0.1:4859';
  }

  async connect() {
    const deadline = Date.now() + 120000;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.baseUrl}/api/manager/system/ping`, { signal: AbortSignal.timeout(2000) });

        if (response.ok && response.headers.has('x-homey-version')) {
          this.version = response.headers.get('x-homey-version');
          break;
        }
      } catch {
        // The listener is unavailable until SHS has booted.
      }

      await delay(500);
    }

    if (!this.version) {
      throw new Error('Disposable SHS did not become ready within 120 seconds');
    }

    // CLI commands share this run's disposable login instead of hitting SHS's
    // login rate limit. This file stays in ignored output, never CI artifacts.
    try {
      this.#token = JSON.parse(await readFile('/output/session.json', 'utf8'));
      await this.request('/manager/zones/zone');
      return;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.status !== 401 && error.status !== 403) {
        throw error;
      }

      this.#token = undefined;
    }

    this.#token = await this.request('/manager/users/login-local', {
      method: 'POST',
      body: { username: TEST_USERNAME, password: TEST_PASSWORD, clientId: 'matter-bridge-tests', clientName: 'Matter Bridge Tests' },
    });
    await writeFile('/output/session.json', JSON.stringify(this.#token), { mode: 0o600 });
  }

  async request(path, { method = 'GET', body } = {}) {
    const headers = {};

    if (this.#token) {
      headers.Authorization = `Bearer ${this.#token}`;
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      // Avoid printing responses that may contain temporary credentials.
      const error = new Error(`${method} ${path}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const text = await response.text();
    return text.length === 0 ? null : JSON.parse(text);
  }

  async install(archive, { appId = APP_ID, readyProperty = 'manualPairingCode' } = {}) {
    const form = new FormData();
    form.set('app', new Blob([await readFile(archive)]), 'app.tar.gz');
    form.set('debug', 'false');
    form.set('purgeSettings', 'true');
    form.set('env', '{}');
    const response = await fetch(`${this.baseUrl}/api/manager/devkit/`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.#token}` }, body: form,
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      throw new Error(`Installing the app in disposable SHS failed: HTTP ${response.status}`);
    }

    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const state = await this.request(`/app/${appId}/state`);

        if (state[readyProperty]) {
          return;
        }
      } catch {
        // The app route is unavailable during startup.
      }

      await delay(500);
    }

    throw new Error(`Installed app ${appId} did not become ready`);
  }

  async stopBridge() {
    await this.request(`/manager/apps/app/${APP_ID}/disable`, { method: 'PUT' });
    await eventually('Bridge app must stop before changing device state', async () => {
      const app = await this.request(`/manager/apps/app/${APP_ID}`);
      return app.state;
    }, 'stopped', 30000);
  }

  async startBridge() {
    await this.request(`/manager/apps/app/${APP_ID}/enable`, { method: 'PUT' });
    await eventually('Bridge app must restore its commissioned server', async () => {
      try {
        const state = await this.state();
        return state.commissioned === true && state.pairing !== null;
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          throw error;
        }

        return false;
      }
    }, true, 60000);
  }

  async state() {
    return await this.request(`/app/${APP_ID}/state`);
  }

  async realtime() {
    return await HomeyAPI.createLocalAPI({ address: this.baseUrl, token: this.#token });
  }

  async createDevice(type, name) {
    const definition = profiles[type];

    if (!definition) {
      throw new Error(`Unknown device fixture: ${type}`);
    }

    const zones = await this.request('/manager/zones/zone');
    const root = Object.values(zones).find((zone) => { return zone.parent == null; });
    const session = await this.request('/manager/drivers/pairsession', {
      method: 'POST', body: { type: 'pair', driverId: `homey:app:${FIXTURE_APP_ID}:${type}`, zoneId: root.id },
    });
    let device;

    try {
      device = await this.request(`/manager/drivers/pairsession/${session.id}/device`, {
        method: 'POST',
        body: { name, data: { id: randomUUID() }, zone: root.id, store: {}, settings: {} },
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const snapshot = await this.fixture(device);

        if (snapshot.initialized) {
          return device;
        }

        await delay(100);
      }

      throw new Error(`Fixture ${type} did not initialize`);
    } catch (error) {
      if (device) {
        await this.request(`/manager/devices/device/${device.id}`, { method: 'DELETE' });
      }

      throw error;
    } finally {
      await this.request(`/manager/drivers/pairsession/${session.id}`, { method: 'DELETE' });
    }
  }

  async fixtureDevices() {
    const devices = await this.request('/manager/devices/device');
    const byType = {};
    const prefix = `homey:app:${FIXTURE_APP_ID}:`;

    for (const device of Object.values(devices)) {
      if (device.driverId.startsWith(prefix)) {
        const type = device.driverId.slice(prefix.length);

        if (byType[type]) {
          throw new Error(`Multiple fixtures for profile ${type}`);
        }

        byType[type] = device;
      }
    }

    return byType;
  }

  static fixturePath(device) {
    const prefix = `homey:app:${FIXTURE_APP_ID}:`;

    if (!device.driverId.startsWith(prefix)) {
      throw new Error('This device is not owned by the fixture app');
    }

    const profile = device.driverId.slice(prefix.length);
    return `/app/${FIXTURE_APP_ID}/devices/${encodeURIComponent(profile)}/${encodeURIComponent(device.data.id)}`;
  }

  async fixture(device) {
    return await this.request(HomeyClient.fixturePath(device));
  }

  async control(device, body) {
    return await this.request(HomeyClient.fixturePath(device), { method: 'POST', body });
  }

  async report(device, values) {
    return await this.control(device, { operation: 'report', values });
  }

  async availability(device, available) {
    return await this.control(device, { operation: 'availability', available });
  }

  async reject(device, capability, rejected) {
    return await this.control(device, { operation: 'reject', capability, rejected });
  }

  async removeDevice(id) {
    await this.share(id, false);
    await this.request(`/manager/devices/device/${id}`, { method: 'DELETE' });
  }

  async set(id, capability, value) {
    await this.request(`/manager/devices/device/${id}/capability/${capability}`, { method: 'PUT', body: { value } });
  }

  async value(id, capability) {
    const device = await this.request(`/manager/devices/device/${id}`);
    return device.capabilitiesObj[capability].value;
  }

  async share(id, enabled) {
    const operation = enabled ? 'enable' : 'disable';
    await this.request(`/app/${APP_ID}/devices/${operation}`, { method: 'POST', body: { deviceId: id } });
  }
}
