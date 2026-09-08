export class PairingPanel {
  constructor({ Homey, container, onCommissionedChanged }) {
    this.Homey = Homey;
    this.container = container;
    this.onCommissionedChanged = onCommissionedChanged;
    this.state = null;
    this.inFlight = false;
    this.disposed = false;
    this.qrCode = null;

    container.innerHTML = `
      <section class="pairing-panel" aria-label="Connect a platform">
        <p data-pairing-message aria-live="polite"></p>
        <p data-pairing-error role="alert" hidden></p>
        <button type="button" class="homey-button-primary" data-pairing-start>Add another platform</button>
        <div class="qr" data-pairing-qr hidden>
          <div class="qr-logo"></div>
          <div class="qr-image" data-pairing-image></div>
          <button type="button" class="qr-text" data-pairing-code aria-label="Copy pairing code"></button>
        </div>
        <p data-pairing-countdown></p>
        <button type="button" class="homey-button-secondary" data-pairing-stop hidden>Stop pairing</button>
      </section>`;

    this.message = container.querySelector('[data-pairing-message]');
    this.error = container.querySelector('[data-pairing-error]');
    this.startButton = container.querySelector('[data-pairing-start]');
    this.stopButton = container.querySelector('[data-pairing-stop]');
    this.qr = container.querySelector('[data-pairing-qr]');
    this.qrImage = container.querySelector('[data-pairing-image]');
    this.code = container.querySelector('[data-pairing-code]');
    this.countdown = container.querySelector('[data-pairing-countdown]');

    this.startButton.addEventListener('click', () => {
      this.request('POST', '/pairing/start').catch((error) => { this.showError(error); });
    });
    this.stopButton.addEventListener('click', () => {
      this.request('POST', '/pairing/stop').catch((error) => { this.showError(error); });
    });
    this.code.addEventListener('click', () => {
      this.copyCode().catch((error) => { this.showError(error); });
    });
  }

  start() {
    this.pollTimer = setInterval(() => {
      this.request('GET', '/state').catch((error) => { this.showError(error); });
    }, 2000);
    this.countdownTimer = setInterval(() => { this.render(); }, 1000);
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.pollTimer);
    clearInterval(this.countdownTimer);
  }

  update(state) {
    if (this.disposed) return;
    const commissionedChanged = this.state !== null && state.commissioned !== this.state.commissioned;
    this.state = state;
    this.render();
    if (commissionedChanged) this.onCommissionedChanged();
  }

  async request(method, path) {
    if (this.inFlight || this.disposed) return;
    this.inFlight = true;
    this.render();
    try {
      const state = await this.Homey.api(method, path);
      if (this.disposed) return;
      this.error.hidden = true;
      this.update(state);
    } finally {
      this.inFlight = false;
      if (!this.disposed) this.render();
    }
  }

  render() {
    if (!this.state || this.disposed) return;

    const initial = this.state.commissioned === false;
    const pairing = this.state.pairing;
    const status = pairing?.status ?? 'busy';
    const open = !initial && status === 'open';
    const remaining = open ? Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000)) : 0;
    const showCodes = initial || (open && remaining > 0);
    const codes = initial ? this.state : pairing;

    const messages = {
      idle: 'Connect another platform to control the same selected devices. Existing connections stay connected.',
      open: 'Scan this temporary QR code in the platform you want to add, or copy the pairing code.',
      completed: 'Platform connected. Your existing connections are still available.',
      expired: 'Pairing expired. Select Add another platform to try again.',
      cancelled: 'Pairing stopped. Your existing connections are still available.',
      external: 'Pairing was opened by another platform. Continue there or wait for it to finish.',
      busy: 'Pairing is in progress. Please wait for it to finish.',
    };
    this.message.textContent = initial
      ? 'Scan the QR code with your Matter controller app, or take a screenshot if you’re on the same device.'
      : messages[status] ?? messages.idle;
    this.startButton.hidden = initial;
    this.startButton.disabled = this.inFlight || open || status === 'external' || status === 'busy';
    this.stopButton.hidden = !open;
    this.stopButton.disabled = this.inFlight;
    this.countdown.textContent = '';
    if (open) {
      this.countdown.textContent = remaining > 0
        ? `Time remaining: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
        : 'Finishing pairing…';
    }

    const qrCode = showCodes ? codes?.qrPairingCode : null;
    this.qr.hidden = !qrCode;
    this.code.textContent = qrCode ? codes.manualPairingCode : '';
    if (qrCode !== this.qrCode) {
      this.qrCode = qrCode;
      this.qrImage.replaceChildren();
      if (qrCode) {
        new globalThis.QRCode(this.qrImage, {
          text: qrCode,
          width: 1024,
          height: 1024,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: globalThis.QRCode.CorrectLevel.H,
        });
      }
    }
  }

  async copyCode() {
    if (this.qr.hidden || !this.code.textContent) return;
    try {
      await navigator.clipboard.writeText(this.code.textContent);
      await this.Homey.alert('The pairing code has been copied to your clipboard.');
    } catch (error) {
      throw new Error('Could not copy the code. You can select it and copy it manually.', { cause: error });
    }
  }

  showError(error) {
    if (this.disposed) return;
    this.error.textContent = error.message ?? String(error);
    this.error.hidden = false;
  }
}
