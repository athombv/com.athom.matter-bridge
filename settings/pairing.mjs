export class PairingPanel {
  constructor({ Homey, container, onCommissionedChanged }) {
    this.Homey = Homey;
    this.container = container;
    this.onCommissionedChanged = onCommissionedChanged;
    this.state = null;
    this.inFlight = false;
    this.disposed = false;
    this.qrCode = null;
    this.manualPairingCode = null;
    this.copiedCode = null;
    this.copying = false;

    container.innerHTML = `
      <section class="pairing-panel" aria-labelledby="pairing-title">
        <h1 id="pairing-title" class="pairing-title" data-pairing-title></h1>
        <p class="pairing-status" data-pairing-status role="status"></p>
        <p class="pairing-message" data-pairing-message aria-live="polite"></p>
        <p class="pairing-error" data-pairing-error role="alert" hidden></p>
        <button type="button" class="homey-button-primary pairing-start" data-pairing-start>Add another platform</button>
        <div class="pairing-card" data-pairing-card hidden>
          <div data-pairing-qr hidden>
            <div class="qr-logo" role="img" aria-label="Matter"></div>
            <div class="qr-image" data-pairing-image role="img" aria-label="Scan this QR code to pair"></div>
            <p class="pairing-code-label" id="pairing-code-label">Pairing code</p>
            <div class="pairing-code-field">
              <span class="pairing-code" data-pairing-code aria-labelledby="pairing-code-label" tabindex="0"></span>
              <button type="button" class="pairing-action pairing-copy hy-nostyle" data-pairing-copy aria-label="Copy pairing code">
                <svg class="pairing-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="12" height="15" rx="2"/><path d="M15 21H5a2 2 0 0 1-2-2V8"/></svg>
                <span data-pairing-copy-label>Copy</span>
              </button>
            </div>
          </div>
          <div class="pairing-window" data-pairing-window hidden>
            <div class="pairing-window-row">
              <p class="pairing-countdown">
                <svg class="pairing-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></svg>
                <span data-pairing-countdown></span>
              </p>
              <button type="button" class="pairing-action hy-nostyle" data-pairing-stop hidden>Stop pairing</button>
            </div>
            <progress class="pairing-progress" data-pairing-progress max="300" value="300" aria-label="Time remaining to pair"></progress>
          </div>
        </div>
        <p class="pairing-note">
          <svg class="pairing-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m10 13 4-4m-7 6-2 2a4 4 0 0 0 6 6l3-3m-4-8 3-3a4 4 0 0 1 6 6l-2 2" transform="translate(0 -3)"/></svg>
          <span data-pairing-note></span>
        </p>
      </section>`;

    this.title = container.querySelector('[data-pairing-title]');
    this.status = container.querySelector('[data-pairing-status]');
    this.message = container.querySelector('[data-pairing-message]');
    this.error = container.querySelector('[data-pairing-error]');
    this.startButton = container.querySelector('[data-pairing-start]');
    this.stopButton = container.querySelector('[data-pairing-stop]');
    this.card = container.querySelector('[data-pairing-card]');
    this.qr = container.querySelector('[data-pairing-qr]');
    this.qrImage = container.querySelector('[data-pairing-image]');
    this.code = container.querySelector('[data-pairing-code]');
    this.copyButton = container.querySelector('[data-pairing-copy]');
    this.copyLabel = container.querySelector('[data-pairing-copy-label]');
    this.windowControls = container.querySelector('[data-pairing-window]');
    this.countdown = container.querySelector('[data-pairing-countdown]');
    this.progress = container.querySelector('[data-pairing-progress]');
    this.note = container.querySelector('[data-pairing-note]');

    this.startButton.addEventListener('click', () => {
      this.request('POST', '/pairing/start').catch((error) => { this.showError(error); });
    });
    this.stopButton.addEventListener('click', () => {
      this.request('POST', '/pairing/stop').catch((error) => { this.showError(error); });
    });
    this.copyButton.addEventListener('click', () => {
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
      idle: 'Connect another platform, or re-pair one you already use.',
      open: 'Scan this temporary code in the platform you want to connect.',
      completed: 'Platform connected. Your existing connections are still available.',
      expired: 'Pairing expired. Select Add another platform to try again.',
      cancelled: 'Pairing stopped. Select Add another platform when you are ready.',
      external: 'Pairing was opened by another platform. Continue there or wait for it to finish.',
      busy: 'Pairing is in progress. Please wait for it to finish.',
    };
    const statuses = {
      idle: ['Ready to pair', 'ready'],
      open: ['Pairing open', 'success'],
      completed: ['Platform connected', 'success'],
      expired: ['Pairing expired', 'warning'],
      cancelled: ['Pairing stopped', 'muted'],
      external: ['Opened elsewhere', 'ready'],
      busy: ['Pairing in progress', 'ready'],
    };
    const [label, tone] = initial ? statuses.idle : statuses[status] ?? statuses.busy;
    if (this.status.textContent !== label) this.status.textContent = label;
    this.status.dataset.tone = tone;
    this.title.textContent = initial ? 'Connect your first platform' : 'Add or re-pair a platform';
    const message = initial
      ? 'Scan this code in your Matter platform to get started.'
      : messages[status] ?? messages.busy;
    if (this.message.textContent !== message) this.message.textContent = message;
    this.note.textContent = initial
      ? 'After pairing, choose which Homey devices to share.'
      : 'Your other platforms stay connected.';
    this.startButton.hidden = initial || open;
    this.startButton.disabled = this.inFlight || status === 'external' || status === 'busy';
    this.stopButton.hidden = !open;
    this.stopButton.disabled = this.inFlight;
    this.windowControls.hidden = !open;
    this.countdown.textContent = '';
    if (open) {
      this.countdown.textContent = remaining > 0
        ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} remaining`
        : 'Finishing pairing…';
    }
    this.progress.value = remaining;

    const qrCode = showCodes ? codes?.qrPairingCode : null;
    this.card.hidden = !qrCode && !open;
    this.qr.hidden = !qrCode;
    const nextManualCode = qrCode ? codes.manualPairingCode : null;
    if (nextManualCode !== this.manualPairingCode) this.copiedCode = null;
    this.manualPairingCode = nextManualCode;
    const manualCode = this.manualPairingCode ?? '';
    const formattedCode = manualCode.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');
    if (this.code.textContent !== formattedCode) this.code.textContent = formattedCode;
    this.copyButton.disabled = this.copying || !manualCode;
    this.copyLabel.textContent = this.copiedCode === manualCode ? 'Copied' : 'Copy';
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
    if (this.qr.hidden || !this.manualPairingCode || this.copying) return;
    const code = this.manualPairingCode;
    this.copying = true;
    this.render();
    try {
      await navigator.clipboard.writeText(code);
      if (this.disposed || this.manualPairingCode !== code) return;
      this.copiedCode = code;
    } catch (error) {
      throw new Error('Could not copy the code. You can select it and copy it manually.', { cause: error });
    } finally {
      this.copying = false;
      this.render();
    }
  }

  showError(error) {
    if (this.disposed) return;
    this.error.textContent = error.message ?? String(error);
    this.error.hidden = false;
  }
}
