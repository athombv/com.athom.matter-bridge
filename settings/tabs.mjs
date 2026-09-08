export class SettingsTabs {
  constructor(container) {
    this.tabList = container.querySelector('[role="tablist"]');
    this.tabs = [...container.querySelectorAll('[role="tab"]')];
    this.panels = [...container.querySelectorAll('[role="tabpanel"]')];

    for (const tab of this.tabs) {
      tab.addEventListener('click', () => { this.select(tab); });
      tab.addEventListener('keydown', (event) => { this.onKeyDown(event); });
    }
  }

  initialize(state) {
    const [devices, pairing] = this.tabs;
    devices.disabled = state.commissioned !== true;
    this.tabList.hidden = devices.disabled;
    const pairingActive = ['open', 'external', 'busy'].includes(state.pairing?.status);
    this.select(devices.disabled || pairingActive ? pairing : devices);
  }

  select(selected) {
    if (selected.disabled) return;

    for (const tab of this.tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of this.panels) {
      panel.hidden = panel.id !== selected.getAttribute('aria-controls');
    }
  }

  onKeyDown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();

    const enabled = this.tabs.filter((tab) => { return !tab.disabled; });
    let index = enabled.indexOf(event.currentTarget);
    switch (event.key) {
      case 'ArrowLeft': index = (index + enabled.length - 1) % enabled.length; break;
      case 'ArrowRight': index = (index + 1) % enabled.length; break;
      case 'Home': index = 0; break;
      case 'End': index = enabled.length - 1; break;
    }
    this.select(enabled[index]);
    enabled[index].focus();
  }
}
