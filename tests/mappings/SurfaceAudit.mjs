import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BridgeHarness } from './BridgeHarness.mjs';

export class SurfaceAudit {
  #catalog;
  #rows = new Map();

  static async create() {
    const catalog = JSON.parse(
      await readFile(new URL('./matter-surface.json', import.meta.url), 'utf8'),
    );
    const audit = new SurfaceAudit();
    audit.#catalog = catalog;
    return audit;
  }

  async check(harness, fixture) {
    const parent = {
      number: harness.bridge.deviceEndpoints[fixture.id].number,
      type: 19,
      clusters: [29, 57],
      features: { Descriptor: {}, BridgedDeviceBasicInformation: {} },
      parts: fixture.endpoints.map((endpoint) => {
        return harness.endpoint(fixture.id, endpoint.id);
      }),
    };

    for (const endpoint of [parent, ...fixture.endpoints]) {
      const number = endpoint.number ?? harness.endpoint(fixture.id, endpoint.id);
      const reports = await harness.readRaw([{ endpointId: number }]);
      const values = new Map();
      for (const report of reports) {
        if (report.kind === 'attr-value') {
          values.set(`${report.path.clusterId}/${report.path.attributeId}`, report.value);
        }
      }

      for (const name of Object.keys(endpoint.features)) {
        const schema = BridgeHarness.cluster(name);
        const cluster = this.#catalog.clusters[name];
        assert.ok(cluster, `Unclassified cluster ${name}`);
        const read = (attribute) => {
          const id = typeof attribute === 'number' ? attribute : schema.attributes[attribute].id;
          const key = `${schema.id}/${id}`;
          assert.ok(
            values.has(key),
            `Advertised attribute not readable: ${fixture.id}/${name}/${attribute}`,
          );
          return values.get(key);
        };

        const attributes = read(65531);
        const commands = read(65529);
        assert.equal(
          new Set(attributes).size,
          attributes.length,
          'Duplicate advertised attributes',
        );
        assert.equal(new Set(commands).size, commands.length, 'Duplicate advertised commands');
        const enabled = (features) => {
          return Object.keys(features)
            .filter((key) => {
              return features[key] === true;
            })
            .sort();
        };
        assert.deepEqual(enabled(read(65532)), enabled(endpoint.features[name]));
        const invariantAttributes = this.#invariants(name, read, endpoint, fixture, parent.number);

        for (const id of attributes) {
          const entry = cluster.attributes[id] ?? this.#catalog.globals[id];
          this.#record(name, 'attribute', id, entry);
          if (entry[1] !== 'tested' || id >= 65528) {
            continue;
          }
          const mapped = fixture.attributes.some((attribute) => {
            return (
              attribute.endpoint === endpoint.id &&
              attribute.cluster === name &&
              attribute.name === entry[0]
            );
          });
          const constant = entry[0] in (endpoint.values?.[name] ?? {});
          assert.ok(
            mapped || constant || invariantAttributes.includes(entry[0]),
            `Declared tested attribute has no check: ${fixture.id}/${name}.${entry[0]}`,
          );
        }
        for (const id of commands) {
          const entry = cluster.commands[id];
          this.#record(name, 'command', id, entry);
          if (entry[1] !== 'tested') {
            continue;
          }
          // These commands have time-dependent or negative contracts in the dedicated reliability
          // suite. The report requires that named test to pass before counting this evidence.
          if (entry[3]) {
            continue;
          }
          const tested = fixture.commands.some((command) => {
            return (
              command.cluster === name &&
              command.name === entry[0] &&
              (command.endpoint ?? 'main') === endpoint.id
            );
          });
          // A position-only source cannot stop and a state-only source cannot set a position.
          // Their explicit failure contracts run in the command reliability suite.
          if (
            name === 'WindowCovering' &&
            entry[0] === 'stopMotion' &&
            !fixture.capabilities[fixture.capabilitySuffix ? `windowcoverings_state.${fixture.capabilitySuffix}` : 'windowcoverings_state']
          ) {
            this.#record(name, 'command', '2-position-only', [
              'stopMotion',
              'tested',
              'Position-only sources explicitly reject stop without changing state or issuing a source write.',
              'cover commands reject unavailable source operations and timed unlock is not advertised',
            ]);
            continue;
          }
          if (
            name === 'WindowCovering' &&
            entry[0] === 'goToLiftPercentage' &&
            !fixture.capabilities[fixture.capabilitySuffix ? `windowcoverings_set.${fixture.capabilitySuffix}` : 'windowcoverings_set']
          ) {
            this.#record(name, 'command', '5-state-only', [
              'goToLiftPercentage',
              'tested',
              'State-only sources explicitly reject position commands without changing state or issuing a source write.',
              'cover commands reject unavailable source operations and timed unlock is not advertised',
            ]);
            continue;
          }
          assert.ok(
            tested,
            `Declared tested command has no contract: ${fixture.id}/${name}.${entry[0]}`,
          );
        }
      }
    }
  }

  #record(cluster, kind, id, entry) {
    assert.ok(entry, `Unclassified advertised ${kind}: ${cluster}/${id}`);
    assert.ok(
      ['tested', 'delegated', 'gap'].includes(entry[1]),
      `Invalid classification for ${cluster}/${id}`,
    );
    assert.ok(entry[2], `Missing rationale for ${cluster}/${id}`);
    this.#rows.set(`${cluster}/${kind}/${id}`, {
      cluster,
      kind,
      id,
      name: entry[0],
      status: entry[1],
      reason: entry[2],
      test: entry[3],
    });
  }

  #invariants(name, read, endpoint, fixture, parentNumber) {
    switch (name) {
      case 'Identify':
        assert.equal(read('identifyType'), 0, 'No physical identification is advertised');
        assert.equal(read('identifyTime'), 0);
        return ['identifyType', 'identifyTime'];
      case 'Descriptor': {
        assert.deepEqual(
          read('deviceTypeList').map((type) => {
            return type.deviceType;
          }),
          [endpoint.type],
        );
        assert.deepEqual(
          [...read('serverList')].sort((a, b) => {
            return a - b;
          }),
          endpoint.clusters,
        );
        assert.deepEqual(read('clientList'), []);
        assert.deepEqual(
          [...read('partsList')].sort((a, b) => {
            return a - b;
          }),
          [...(endpoint.parts ?? [])].sort((a, b) => {
            return a - b;
          }),
        );
        return ['deviceTypeList', 'serverList', 'clientList', 'partsList'];
      }
      case 'BridgedDeviceBasicInformation': {
        assert.equal(read('vendorName'), 'Test');
        assert.equal(read('productName'), 'Synthetic mapping fixture');
        // This fixture exceeds Matter's label limit; keep the expected truncation literal.
        const label =
          fixture.id === 'thermostat-off-heat-cool-auto-separate'
            ? 'thermostat-off-heat-cool-auto…'
            : fixture.id;
        assert.equal(read('nodeLabel'), label);
        const serial =
          fixture.id === 'thermostat-off-heat-cool-auto-separate'
            ? 'thermostatoffheatcoolautosepa…'
            : fixture.id.replaceAll('-', '');
        assert.equal(read('serialNumber'), serial);
        assert.equal(read('reachable'), true);
        return ['vendorName', 'productName', 'nodeLabel', 'serialNumber', 'reachable'];
      }
      case 'ColorControl': {
        const mode = read('colorMode');
        assert.equal(read('enhancedColorMode'), mode, 'Color mode attributes must agree');
        const features = endpoint.features.ColorControl;
        assert.ok(
          (mode === 0 && features.hueSaturation) || (mode === 2 && features.colorTemperature),
          'Mode must have an advertised feature',
        );
        const enabled = (bitmap) => {
          return Object.keys(bitmap)
            .filter((key) => {
              return bitmap[key];
            })
            .sort();
        };
        assert.deepEqual(enabled(read('colorCapabilities')), enabled(read(65532)));
        if (features.colorTemperature) {
          assert.equal(read('colorTempPhysicalMinMireds'), 153);
          assert.equal(read('colorTempPhysicalMaxMireds'), 400);
          assert.equal(read('coupleColorTempToLevelMinMireds'), 153);
          assert.ok(read('colorTemperatureMireds') >= 153 && read('colorTemperatureMireds') <= 400);
        }
        return [
          'colorMode',
          'enhancedColorMode',
          'colorCapabilities',
          'colorTempPhysicalMinMireds',
          'colorTempPhysicalMaxMireds',
          'coupleColorTempToLevelMinMireds',
        ];
      }
      case 'LevelControl':
        assert.equal(read('minLevel'), 1);
        assert.equal(read('maxLevel'), 254);
        assert.ok(
          read('currentLevel') === null ||
            (read('currentLevel') >= 1 && read('currentLevel') <= 254),
        );
        return ['minLevel', 'maxLevel'];
      case 'Thermostat': {
        const features = endpoint.features.Thermostat;
        for (const kind of ['Heat', 'Cool']) {
          if (!features[kind === 'Heat' ? 'heating' : 'cooling']) {
            continue;
          }
          assert.equal(read(`absMin${kind}SetpointLimit`), 1600);
          assert.equal(read(`min${kind}SetpointLimit`), 1600);
          assert.equal(read(`absMax${kind}SetpointLimit`), 3000);
          assert.equal(read(`max${kind}SetpointLimit`), 3000);
          const target = read(`occupied${kind}ingSetpoint`);
          assert.ok(target >= 1600 && target <= 3000);
        }
        const modes = fixture.capabilities[fixture.capabilitySuffix ? `thermostat_mode.${fixture.capabilitySuffix}` : 'thermostat_mode']?.values?.map((entry) => {
          return { off: 0, heat: 4, cool: 3, auto: 1 }[entry.id];
        }) ?? [features.heating ? 4 : 3];
        assert.ok(
          modes.includes(read('systemMode')),
          'Thermostat mode must be supported by the source',
        );
        let sequence = 0;
        if (features.heating) {
          sequence = features.cooling ? 4 : 2;
        }
        assert.equal(read('controlSequenceOfOperation'), sequence);
        if (features.autoMode) {
          assert.equal(read('minSetpointDeadBand'), 0);
        }
        return [
          'absMinHeatSetpointLimit',
          'absMaxHeatSetpointLimit',
          'absMinCoolSetpointLimit',
          'absMaxCoolSetpointLimit',
          'minHeatSetpointLimit',
          'maxHeatSetpointLimit',
          'minCoolSetpointLimit',
          'maxCoolSetpointLimit',
          'minSetpointDeadBand',
          'controlSequenceOfOperation',
          'systemMode',
        ];
      }
      case 'WindowCovering': {
        const status = read('operationalStatus');
        assert.equal(status.global, status.lift);
        assert.equal(status.tilt, 0);
        assert.equal(
          read('configStatus').liftPositionAware,
          !!endpoint.features.WindowCovering.positionAwareLift,
        );
        if (endpoint.features.WindowCovering.positionAwareLift) {
          assert.equal(
            read('targetPositionLiftPercent100ths'),
            read('currentPositionLiftPercent100ths'),
          );
        }
        return ['operationalStatus', 'targetPositionLiftPercent100ths', 'configStatus'];
      }
      case 'OccupancySensing': {
        const ultrasonic = fixture.capabilities[fixture.capabilitySuffix ? `alarm_occupancy.${fixture.capabilitySuffix}` : 'alarm_occupancy'] !== undefined;
        assert.equal(read('occupancySensorType'), ultrasonic ? 1 : 0);
        const bitmap = read('occupancySensorTypeBitmap');
        assert.equal(bitmap.ultrasonic, ultrasonic);
        assert.equal(bitmap.pir, !ultrasonic);
        return ['occupancySensorType', 'occupancySensorTypeBitmap'];
      }
      case 'FanControl': {
        assert.equal(read('fanModeSequence'), 5);
        assert.equal(read('percentCurrent'), read('percentSetting'));
        assert.equal(read('fanMode'), read('percentCurrent') === 0 ? 0 : 3);
        return ['fanMode', 'fanModeSequence', 'percentCurrent'];
      }
      case 'ElectricalEnergyMeasurement': {
        const accuracy = read('accuracy');
        assert.equal(accuracy.measurementType, 14);
        assert.equal(accuracy.measured, true);
        assert.ok(accuracy.minMeasuredValue <= accuracy.maxMeasuredValue);
        return ['accuracy'];
      }
      case 'PowerSource': {
        assert.equal(read('status'), 1);
        assert.equal(read('order'), 0);
        assert.equal(read('description'), 'Battery');
        assert.equal(read('batPresent'), true);
        assert.equal(read('batReplaceability'), 0);
        assert.deepEqual(read('endpointList'), [parentNumber]);
        assert.equal(read('batReplacementNeeded'), read('batChargeLevel') > 0);
        return ['status', 'order', 'description', 'batPresent', 'batReplaceability',
          'endpointList', 'batReplacementNeeded', 'batChargeLevel'];
      }
      case 'ElectricalPowerMeasurement': {
        assert.equal(read('powerMode'), 0);
        const accuracy = read('accuracy');
        assert.equal(read('numberOfMeasurementTypes'), accuracy.length);
        const expectedTypes = fixture.attributes.filter((attribute) => {
          return attribute.endpoint === endpoint.id && attribute.cluster === name;
        }).map((attribute) => {
          return { activePower: 5, voltage: 1, activeCurrent: 2 }[attribute.name];
        });
        assert.deepEqual(accuracy.map((entry) => {
          return entry.measurementType;
        }).sort(), expectedTypes.sort());
        for (const entry of accuracy) {
          assert.ok(entry.minMeasuredValue <= entry.maxMeasuredValue);
        }
        if (!expectedTypes.includes(5)) {
          assert.equal(read('activePower'), null, 'Required power attribute has no source reading');
        }
        return ['powerMode', 'numberOfMeasurementTypes', 'accuracy', 'activePower'];
      }
      case 'AirQuality':
        assert.equal(read('airQuality'), 0, 'No source capability classifies overall air quality');
        return ['airQuality'];
      case 'DoorLock':
        assert.equal(read('actuatorEnabled'), true);
        assert.equal(read('operatingMode'), 0);
        // Matter 1.3 section 5.2.9.28: a set bit means the mode is unsupported.
        assert.equal(read('supportedOperatingModes').normal, false);
        return ['actuatorEnabled', 'operatingMode', 'supportedOperatingModes'];
      case 'SmokeCoAlarm':
        assert.equal(read('expressedState'), read('smokeState') > 0 ? 1 : 0);
        return ['expressedState', 'smokeState'];
      default:
        if (name.endsWith('Measurement')) {
          const min = read('minMeasuredValue');
          const max = read('maxMeasuredValue');
          const value = read('measuredValue');
          if (min !== null && max !== null) {
            assert.ok(min <= max);
          }
          if (value !== null && min !== null) {
            assert.ok(value >= min);
          }
          if (value !== null && max !== null) {
            assert.ok(value <= max);
          }
          return ['minMeasuredValue', 'maxMeasuredValue'];
        }
        return [];
    }
  }

  report() {
    const rows = [...this.#rows.values()];
    const counts = { tested: 0, delegated: 0, gap: 0 };
    for (const row of rows) {
      counts[row.status]++;
    }
    return { counts, entries: rows };
  }
}
