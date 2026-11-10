import { setTimeout as delay } from 'node:timers/promises';
import { APP_ID } from '../../../scripts/integration/config.mjs';

/** Commission through SHS's actual Matter driver and daemon, without a pairing UI. */
export class HomeyMatterController {
  constructor(homey) {
    this.homey = homey;
  }

  async connect(diagnostic) {
    this.api = await this.homey.realtime();
    const messages = [];
    const stages = [];
    const onMessage = (message) => { messages.push(message); };
    this.api.drivers.on('pair.message', onMessage);
    await this.api.drivers.connect();
    const session = await this.homey.request('/manager/drivers/pairsession', {
      method: 'POST', body: { type: 'pair', driverId: 'homey:virtualdrivermatter:driver' },
    });
    const path = `/manager/drivers/pairsession/${session.id}`;
    const emit = async (event, data) => {
      return await this.homey.request(`${path}/emit`, { method: 'POST', body: { event, data } });
    };

    try {
      let state = await this.homey.state();

      if (state.commissioned) {
        state = await this.homey.request(`/app/${APP_ID}/pairing/start`, { method: 'POST' });
      }

      const onboardingPayload = state.qrPairingCode ?? state.pairing?.qrPairingCode;

      if (!onboardingPayload) {
        throw new Error('Bridge API did not return an active pairing payload');
      }

      await emit('commissionDevice', { onboardingPayload, scanBle: false });
      const deadline = Date.now() + 120000;
      let heartbeatAt = 0;

      while (Date.now() < deadline) {
        if (Date.now() >= heartbeatAt) {
          await this.homey.request(`${path}/heartbeat`, { method: 'POST' });
          heartbeatAt = Date.now() + 10000;
        }

        for (const message of messages.splice(0)) {
          if (message.sessionId !== session.id) {
            continue;
          }

          if (message.event === 'done') {
            if (message.data.success !== true) {
              throw new Error(`Homey commissioning failed: ${message.data.subtitle}`);
            }

            diagnostic(`Homey commissioned and interviewed the bridge without a UI (stages: ${stages.join(', ')})`);
            return;
          }

          if (message.event === 'status') {
            stages.push(message.data.code);
          }

          if (message.event === '$showView') {
            if (message.data === 'uncertified-device') {
              // Only this runner's isolated development bridge is eligible for this exception.
              await emit('uncertified-device-chosen', { allow: true });
              diagnostic('Accepted the isolated development bridge through Homey\'s uncertified-device pairing step');
            } else if (message.data === 'install-app') {
              await emit('driver-chosen', { shouldUseAppStoreDriver: false });
            } else {
              throw new Error(`Unexpected Homey pairing step: ${message.data}`);
            }
          }
        }

        await delay(100);
      }

      throw new Error('Homey Matter commissioning did not finish within 120 seconds');
    } finally {
      this.api.drivers.removeListener('pair.message', onMessage);
      await this.homey.request(path, { method: 'DELETE' });
    }
  }

  async close() {
    try {
      await this.api?.drivers.disconnect();
    } finally {
      await this.api?.disconnect();
    }
  }
}
