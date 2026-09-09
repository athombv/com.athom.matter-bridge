import { AdministratorCommissioningServer } from '@matter/main/behaviors/administrator-commissioning';
import { AdministratorCommissioning } from '@matter/main/clusters/administrator-commissioning';
import { CommissioningServer, Crypto, Time } from '@matter/main';
import { DeviceCommissioner, FailsafeContext, PaseClient, PaseServer, SessionManager } from '@matter/main/protocol';
import { ManualPairingCodeCodec, QrPairingCodeCodec } from '@matter/main/types';

const { WindowNotOpen, EnhancedWindowOpen } = AdministratorCommissioning.CommissioningWindowStatus;

export class BridgeCommissioningServer extends AdministratorCommissioningServer {
  static pairingDurationMs = 5 * 60 * 1000;

  static Internal = class extends AdministratorCommissioningServer.Internal {
    pairing = null;
    remoteOpening = false;
    windowClosed = null;
    windowExpired = null;
    commissioned = null;
  };

  initialize() {
    super.initialize();
    this.internal.windowClosed = this.callback(this.#windowClosed);
    this.internal.windowExpired = this.callback(this.#windowExpired);
    this.internal.commissioned = this.asyncCallback(this.#commissioned, { lock: true, offline: true });
    this.reactTo(this.env.eventsFor(FailsafeContext).added, this.#failsafeAdded);
    this.reactTo(this.env.eventsFor(FailsafeContext).deleted, this.#failsafeRemoved);
  }

  callback(reactor, options = {}) {
    // The inherited remote-window callbacks write this cluster too. Queue them
    // behind active operations instead of trying to acquire a synchronous lock.
    return super.callback(reactor, { lock: true, offline: true, ...options });
  }

  getLocalPairing() {
    const pairing = this.internal.pairing;
    const commissioner = this.env.get(DeviceCommissioner);

    if (pairing?.active) {
      return {
        status: 'open',
        expiresAt: pairing.expiresAt,
        qrPairingCode: pairing.qrPairingCode,
        manualPairingCode: pairing.manualPairingCode,
      };
    }

    let status = pairing?.status ?? 'idle';
    if (this.internal.remoteOpening || this.state.windowStatus !== WindowNotOpen) {
      status = 'external';
    } else if (commissioner.isFailsafeArmed) {
      status = 'busy';
    }

    return { status, expiresAt: null, qrPairingCode: null, manualPairingCode: null };
  }

  async startLocalPairing() {
    await this.context.transaction.addResources(this);
    await this.context.transaction.begin();
    if (this.internal.pairing?.active) return;

    const commissioner = this.env.get(DeviceCommissioner);
    if (this.internal.remoteOpening || this.state.windowStatus !== WindowNotOpen || commissioner.isFailsafeArmed) {
      return;
    }
    if (!this.endpoint.lifecycle.isCommissioned) {
      throw new Error('Complete the initial setup before adding another platform.');
    }

    const commissioning = this.agent.get(CommissioningServer).state;
    const crypto = this.env.get(Crypto);
    const passcode = PaseClient.generateRandomPasscode(crypto);
    const discriminator = PaseClient.generateRandomDiscriminator(crypto);
    const [originalPayload] = QrPairingCodeCodec.decode(commissioning.pairingCodes.qrPairingCode);
    const pairing = {
      active: true,
      status: 'open',
      expiresAt: Date.now() + this.constructor.pairingDurationMs,
      qrPairingCode: QrPairingCodeCodec.encode([{ ...originalPayload, passcode, discriminator }]),
      manualPairingCode: ManualPairingCodeCodec.encode({ passcode, discriminator }),
      previousFabrics: new Set(Object.keys(commissioning.fabrics)),
      awaitingCompletion: true,
      stopMonitoringFailsafe: null,
      timer: null,
    };
    this.internal.pairing = pairing;

    try {
      const paseServer = await PaseServer.fromPin(this.env.get(SessionManager), passcode, {
        iterations: 1000,
        salt: crypto.randomBytes(32),
      });

      this.state.windowStatus = EnhancedWindowOpen;
      this.state.adminFabricIndex = null;
      this.state.adminVendorId = null;
      const windowClosed = this.internal.windowClosed;
      await commissioner.allowEnhancedCommissioning(discriminator, paseServer, () => { windowClosed(pairing); });

      const windowExpired = this.internal.windowExpired;
      pairing.expiresAt = Date.now() + this.constructor.pairingDurationMs;
      pairing.timer = Time.getTimer(
        'Bridge pairing timeout',
        this.constructor.pairingDurationMs,
        () => { windowExpired(pairing); },
      ).start();
    } catch (error) {
      pairing.awaitingCompletion = false;
      await commissioner.endCommissioning();
      this.#clearLocalPairing('idle');
      throw new Error('Unable to start pairing.', { cause: error });
    }
  }

  async stopLocalPairing() {
    await this.#stopLocalPairing('cancelled');
  }

  async expireLocalPairing() {
    await this.#stopLocalPairing('expired');
  }

  async #windowExpired(pairing) {
    if (this.internal.pairing !== pairing) return;
    await this.expireLocalPairing();
  }

  async #stopLocalPairing(status) {
    await this.context.transaction.addResources(this);
    await this.context.transaction.begin();
    if (!this.internal.pairing?.active) return;

    // Mark the outcome before closing: the commissioner calls back into this behavior.
    this.internal.pairing.status = status;
    this.internal.pairing.awaitingCompletion = false;
    await this.env.get(DeviceCommissioner).endCommissioning();
    if (this.env.has(FailsafeContext)) {
      const failsafe = this.env.get(FailsafeContext);
      await failsafe.close();
    } else {
      const session = this.env.get(SessionManager).getPaseSession();
      if (session) await session.close();
    }
    this.#clearLocalPairing(status);
  }

  #windowClosed(pairing) {
    if (this.internal.pairing !== pairing || !pairing.active) return;

    const status = pairing.status === 'open' ? 'idle' : pairing.status;
    this.#clearLocalPairing(status);
  }

  #clearLocalPairing(status) {
    const pairing = this.internal.pairing;
    if (!pairing) return;

    pairing.timer?.stop();
    pairing.timer = null;
    pairing.active = false;
    pairing.status = status;
    pairing.expiresAt = null;
    pairing.qrPairingCode = null;
    pairing.manualPairingCode = null;
    this.state.windowStatus = WindowNotOpen;
    this.state.adminFabricIndex = null;
    this.state.adminVendorId = null;
  }

  #failsafeAdded(failsafe) {
    const pairing = this.internal.pairing;
    if (!pairing?.active) return;

    pairing.stopMonitoringFailsafe?.();
    const commissioned = this.internal.commissioned;
    const completed = async () => { await commissioned(pairing, failsafe.fabricIndex); };
    failsafe.commissioned.on(completed);
    pairing.stopMonitoringFailsafe = () => { failsafe.commissioned.off(completed); };
  }

  #failsafeRemoved() {
    this.internal.pairing?.stopMonitoringFailsafe?.();
    if (this.internal.pairing) this.internal.pairing.stopMonitoringFailsafe = null;
  }

  #commissioned(pairing, fabricIndex) {
    if (this.internal.pairing !== pairing || !pairing.awaitingCompletion || fabricIndex === undefined) return;
    if (pairing.previousFabrics.has(String(fabricIndex))) return;

    // FailsafeContext emits this after disarming the failsafe and persisting the
    // fabric. Fabric changes alone also occur during rollback and are not success.
    pairing.awaitingCompletion = false;
    this.#clearLocalPairing('completed');
  }

  async openCommissioningWindow(request) {
    await this.context.transaction.addResources(this);
    await this.context.transaction.begin();
    this.#assertNoLocalPairing();
    this.internal.remoteOpening = true;
    try {
      await super.openCommissioningWindow(request);
    } finally {
      this.internal.remoteOpening = false;
    }
  }

  async openBasicCommissioningWindow(request) {
    await this.context.transaction.addResources(this);
    await this.context.transaction.begin();
    this.#assertNoLocalPairing();
    this.internal.remoteOpening = true;
    try {
      await super.openBasicCommissioningWindow(request);
    } finally {
      this.internal.remoteOpening = false;
    }
  }

  #assertNoLocalPairing() {
    if (this.internal.pairing?.active) {
      throw new AdministratorCommissioning.BusyError('Pairing is already open in Homey.');
    }
    if (this.internal.pairing) this.internal.pairing.awaitingCompletion = false;
  }

  async revokeCommissioning() {
    await this.context.transaction.addResources(this);
    await this.context.transaction.begin();
    if (this.internal.pairing?.active) {
      await this.stopLocalPairing();
      return;
    }
    await super.revokeCommissioning();
  }

  [Symbol.asyncDispose]() {
    this.internal.pairing?.timer?.stop();
    this.internal.pairing?.stopMonitoringFailsafe?.();
    this.internal.pairing = null;
    super[Symbol.asyncDispose]();
  }
}
