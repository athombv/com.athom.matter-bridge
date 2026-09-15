export class DevicesPanel {
  constructor({ Homey, container, selectedCount, template }) {
    this.Homey = Homey;
    this.container = container;
    this.selectedCount = selectedCount;
    this.template = template;
    this.document = container.ownerDocument;
    this.devices = [];
  }

  render(devices) {
    this.devices = devices;
    this.container.replaceChildren();
    this.updateSelectedCount();
    const zones = new Map();

    for (const device of devices) {
      const zone = device.zoneName || 'Other';

      if (!zones.has(zone)) {
        zones.set(zone, []);
      }
      zones.get(zone).push(device);
    }

    const root = this.document.createElement('div');
    root.className = 'zones';
    this.container.appendChild(root);

    for (const name of [...zones.keys()].sort()) {
      const zone = this.document.createElement('section');
      zone.className = 'zone';
      const heading = this.document.createElement('h2');
      heading.className = 'zone-name';
      heading.textContent = name;
      const tiles = this.document.createElement('div');
      tiles.className = 'zone-devices';
      zone.append(heading, tiles);
      root.appendChild(zone);

      for (const device of zones.get(name)) {
        tiles.appendChild(this.renderDevice(device));
      }
    }
  }

  renderDevice(device) {
    const card = this.document.createElement('div');
    card.className = 'device-card';
    const tile = this.template.content.cloneNode(true);
    const input = tile.querySelector('[data-template-device-input]');
    const name = tile.querySelector('[data-template-device-name]');
    const icon = tile.querySelector('[data-template-device-icon]');
    name.textContent = device.name;
    name.title = device.name;
    input.checked = device.isSelected;
    input.disabled = !device.support.canShare && !device.isSelected;
    input.setAttribute('aria-label', device.name);
    input.addEventListener('change', () => {
      this.updateDeviceSelection(device, input).catch((error) => {
        this.Homey.error(error);
      });
    });
    this.renderIcon(device, icon);
    card.appendChild(tile);

    const { canShare, supportedCapabilities, unsupportedCapabilities } = device.support;
    const hasNumericAirQuality = supportedCapabilities.some(({ id }) => {
      return ['measure_co2', 'measure_pm10', 'measure_pm25'].includes(id);
    });

    if (!canShare || unsupportedCapabilities.length > 0 || hasNumericAirQuality) {
      const details = this.document.createElement('details');
      details.className = 'device-support';
      const summary = this.document.createElement('summary');
      summary.textContent = 'Sharing details';

      if (!canShare) {
        summary.textContent = 'Not supported';
      } else if (unsupportedCapabilities.length > 0) {
        summary.textContent = 'Partly shared';
      }
      details.appendChild(summary);

      const description = this.document.createElement('p');
      const shared = supportedCapabilities.map(({ title }) => {
        return title;
      }).join(', ');
      description.textContent = canShare
        ? `Shared: ${shared}.`
        : 'No supported capabilities. If already selected, you can deselect this device.';
      details.appendChild(description);

      if (unsupportedCapabilities.length > 0) {
        const omitted = this.document.createElement('p');
        const titles = unsupportedCapabilities.map(({ title }) => {
          return title;
        }).join(', ');
        omitted.textContent = `Not shared: ${titles}.`;
        details.appendChild(omitted);
      }

      if (hasNumericAirQuality) {
        const note = this.document.createElement('p');
        note.textContent = 'Numeric air readings are shared. An overall air-quality rating is not available.';
        details.appendChild(note);
      }

      const descriptionId = `device-support-${this.devices.indexOf(device)}`;
      details.id = descriptionId;
      input.setAttribute('aria-describedby', descriptionId);
      card.appendChild(details);
    }

    return card;
  }

  renderIcon(device, icon) {
    const fallback = () => {
      if (device.iconUrl) {
        icon.style.maskImage = `url(${device.iconUrl})`;
      } else {
        icon.classList.add('is-missing');
      }
    };

    if (!device.iconOverride) {
      fallback();
      return;
    }

    const iconUrl = `https://athombv.github.io/node-homey-lib/assets/device/icons/${device.iconOverride}.svg`;
    const image = new this.document.defaultView.Image();
    image.onload = () => {
      icon.style.maskImage = `url(${iconUrl})`;
    };
    image.onerror = fallback;
    image.src = iconUrl;
  }

  async updateDeviceSelection(device, input) {
    const selected = input.checked;
    input.disabled = true;

    try {
      const path = selected ? '/devices/enable' : '/devices/disable';
      await this.Homey.api('POST', path, { deviceId: device.id });
      device.isSelected = selected;
    } catch (error) {
      input.checked = device.isSelected;
      throw error;
    } finally {
      input.disabled = !device.support.canShare && !device.isSelected;
      this.updateSelectedCount();
    }
  }

  updateSelectedCount() {
    const selected = this.devices.filter((device) => {
      return device.isSelected;
    }).length;
    this.selectedCount.textContent = `${selected} selected`;
  }
}
