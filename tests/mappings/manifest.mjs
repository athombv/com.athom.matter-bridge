// Expectations are independent of bridge conversion helpers. Numeric values refer to Matter attributes.
export const backendReference = {
  revision: 'bafec2787531c8065e49622a73ed6a42f23b3669',
  library: 'packages/homey-local/lib/matter/data-model/cluster/library/',
  fixtures: 'packages/homey-local/test/matter/real-devices/assets/',
};

function capability(value, options = {}) {
  return { value, type: typeof value, getable: true, setable: false, ...options };
}
function attribute(capabilityId, cluster, name, initial, updates, endpoint = 'main') {
  return { capabilityId, cluster, name, initial, updates, endpoint };
}
function command(cluster, name, fields, writes, endpoint = 'main') {
  return { cluster, name, fields, writes, endpoint };
}
const onoff = attribute('onoff', 'OnOff', 'onOff', true, [
  [false, false],
  [true, true],
]);
const onoffCommands = [
  command('OnOff', 'off', {}, { onoff: false }),
  command('OnOff', 'on', {}, { onoff: true }),
];
const level = attribute('dim', 'LevelControl', 'currentLevel', 128, [
  [0, 1],
  [1, 254],
  [0.25, 64],
  [null, null],
]);
const levelCommands = [
  command(
    'LevelControl',
    'moveToLevel',
    { level: 254, transitionTime: 0, optionsMask: {}, optionsOverride: {} },
    { dim: 1 },
  ),
  command(
    'LevelControl',
    'moveToLevelWithOnOff',
    { level: 0, transitionTime: 0, optionsMask: {}, optionsOverride: {} },
    { dim: 0, onoff: false },
  ),
];
const hue = attribute('light_hue', 'ColorControl', 'currentHue', 127, [
  [0, 0],
  [1, 254],
  [0.25, 64],
]);
const saturation = attribute('light_saturation', 'ColorControl', 'currentSaturation', 127, [
  [0, 0],
  [1, 254],
  [0.25, 64],
]);
const temperature = attribute('light_temperature', 'ColorControl', 'colorTemperatureMireds', 151, [
  [0, 1],
  [1, 300],
  [0.25, 76],
]);
const hueCommand = command(
  'ColorControl',
  'moveToHueAndSaturation',
  { hue: 127, saturation: 127, transitionTime: 0, optionsMask: {}, optionsOverride: {} },
  { onoff: true, light_hue: 0.5, light_saturation: 0.5 },
);
const temperatureCommand = command(
  'ColorControl',
  'moveToColorTemperature',
  { colorTemperatureMireds: 300, transitionTime: 0, optionsMask: {}, optionsOverride: {} },
  { onoff: true, light_temperature: 1 },
);

export const mappings = [
  {
    id: 'socket',
    class: 'socket',
    source: 'measurement-and-sensing/ElectricalPowerMeasurementCluster.mts',
    capabilities: {
      onoff: capability(true, { setable: true }),
      measure_power: capability(12, { units: 'W' }),
    },
    endpoints: [{ id: 'main', type: 0x10a, features: { ElectricalPowerMeasurement: {} } }],
    attributes: [
      onoff,
      attribute('measure_power', 'ElectricalPowerMeasurement', 'activePower', 12000, [
        [0, 0],
        [1.25, 1250],
        [null, null],
      ]),
    ],
    commands: onoffCommands,
  },
];
for (const variant of [
  'onoff',
  'dimmable',
  'color',
  'temperature',
  'extended-color',
  'extended-temperature',
]) {
  const capabilities = { onoff: capability(true, { setable: true }) };
  const attributes = [onoff];
  const commands = [...onoffCommands];
  const features = {};
  let type = 0x100;
  if (variant !== 'onoff') {
    capabilities.dim = capability(0.5, { setable: true, min: 0, max: 1 });
    attributes.push(level);
    commands.push(...levelCommands);
    type = 0x101;
  }
  if (variant.includes('color') || variant.startsWith('extended')) {
    capabilities.light_hue = capability(0.5, { setable: true, min: 0, max: 1 });
    capabilities.light_saturation = capability(0.5, { setable: true, min: 0, max: 1 });
    attributes.push(hue, saturation);
    commands.push(structuredClone(hueCommand));
    features.ColorControl = { hueSaturation: true };
  }
  if (variant.includes('temperature') || variant.startsWith('extended')) {
    capabilities.light_temperature = capability(0.5, { setable: true, min: 0, max: 1 });
    attributes.push(temperature);
    commands.push(structuredClone(temperatureCommand));
    features.ColorControl = { ...features.ColorControl, colorTemperature: true };
    type = 0x10c;
  }
  if (variant.startsWith('extended')) {
    const mode = variant === 'extended-color' ? 'color' : 'temperature';
    capabilities.light_mode = capability(mode, {
      setable: true,
      type: 'enum',
      values: [{ id: 'color' }, { id: 'temperature' }],
    });
    attributes.push(
      attribute('light_mode', 'ColorControl', 'colorMode', mode === 'color' ? 0 : 2, [
        ['color', 0],
        ['temperature', 2],
      ]),
    );
    for (const cmd of commands) {
      if (cmd.cluster === 'ColorControl') {
        cmd.writes.light_mode = cmd.name === 'moveToColorTemperature' ? 'temperature' : 'color';
      }
    }
    type = 0x10d;
  }
  let source = 'lighting/ColorControlCluster.mts';
  if (variant === 'onoff') {
    source = 'general/OnOffCluster.mts';
  }
  if (variant === 'dimmable') {
    source = 'general/LevelControlCluster.mts';
  }
  mappings.push({
    id: `light-${variant}`,
    class: 'light',
    source,
    capabilities,
    endpoints: [{ id: 'main', type, features }],
    attributes,
    commands,
  });
}
for (const modes of [null, ['off', 'heat'], ['off', 'cool'], ['off', 'heat', 'cool', 'auto']]) {
  for (const separate of modes?.includes('cool') ? [false, true] : [false]) {
    const coolingOnly = modes?.includes('cool') && !modes.includes('heat');
    const mode = coolingOnly ? 'cool' : 'heat';
    const id = `thermostat-${modes?.join('-') ?? 'implicit'}${separate ? '-separate' : ''}`;
    const capabilities = {
      target_temperature: capability(21.5, {
        setable: true,
        units: '°C',
        min: 16,
        max: 30,
        step: 0.5,
      }),
      measure_temperature: capability(20.25, { units: '°C' }),
      measure_humidity: capability(45.5, { units: '%' }),
    };
    if (modes) {
      capabilities.thermostat_mode = capability(mode, {
        setable: true,
        type: 'enum',
        values: modes.map((id) => {
          return { id };
        }),
      });
    }
    if (separate) {
      capabilities['target_temperature.cool'] = capability(24.5, {
        setable: true,
        units: '°C',
        min: 16,
        max: 30,
        step: 0.5,
      });
    }
    if (coolingOnly && separate) {
      delete capabilities.target_temperature;
    }
    const attributes = [
      attribute('measure_temperature', 'Thermostat', 'localTemperature', 2025, [
        [0, 0],
        [-5.5, -550],
        [null, null],
      ]),
      attribute(
        'measure_humidity',
        'RelativeHumidityMeasurement',
        'measuredValue',
        4550,
        [
          [0, 0],
          [100, 10000],
          [null, null],
        ],
        'measure_humidity',
      ),
    ];
    const writes = [];
    if (!coolingOnly) {
      attributes.push(
        attribute('target_temperature', 'Thermostat', 'occupiedHeatingSetpoint', 2150, [
          [16, 1600],
          [21.5, 2150],
          [30, 3000],
        ]),
      );
      writes.push({
        cluster: 'Thermostat',
        attribute: 'occupiedHeatingSetpoint',
        value: 2250,
        writes: { target_temperature: 22.5 },
      });
    }
    if (modes?.includes('cool')) {
      const target = separate ? 'target_temperature.cool' : 'target_temperature';
      attributes.push(
        attribute(target, 'Thermostat', 'occupiedCoolingSetpoint', separate ? 2450 : 2150, [
          [16, 1600],
          [24.5, 2450],
          [30, 3000],
        ]),
      );
      writes.push({
        cluster: 'Thermostat',
        attribute: 'occupiedCoolingSetpoint',
        value: 2550,
        writes: { [target]: 25.5 },
      });
    }
    if (modes) {
      const enumValues = { off: 0, heat: 4, cool: 3, auto: 1 };
      attributes.push(
        attribute(
          'thermostat_mode',
          'Thermostat',
          'systemMode',
          enumValues[mode],
          modes.map((mode) => {
            return [mode, enumValues[mode]];
          }),
        ),
      );
      for (const mode of modes) {
        writes.push({
          cluster: 'Thermostat',
          attribute: 'systemMode',
          value: enumValues[mode],
          writes: { thermostat_mode: mode },
        });
      }
    }
    const prepare = {};
    for (const [capabilityId, capability] of Object.entries(capabilities)) {
      if (capabilityId.startsWith('target_temperature')) {
        prepare[capabilityId] = capability.value;
      }
    }

    const adjustsSeparateCoolingTarget = coolingOnly && separate;
    const adjustedCapability = adjustsSeparateCoolingTarget
      ? 'target_temperature.cool'
      : 'target_temperature';
    const adjustedValue = adjustsSeparateCoolingTarget ? 24 : 21;

    mappings.push({
      id,
      class: 'thermostat',
      source: 'hvac/ThermostatCluster.mts',
      capabilities,
      endpoints: [
        {
          id: 'main',
          type: 0x301,
          features: {
            Thermostat: {
              heating: !coolingOnly,
              cooling: !!modes?.includes('cool'),
              autoMode: !!modes?.includes('auto'),
            },
          },
        },
        { id: 'measure_humidity', type: 0x307 },
      ],
      attributes,
      commands: [
        {
          ...command(
            'Thermostat',
            'setpointRaiseLower',
            { mode: coolingOnly ? 1 : 0, amount: -5 },
            {
              [adjustedCapability]: adjustedValue,
            },
          ),
          prepare,
        },
      ],
      writes,
    });
  }
}
for (const locked of [true, false, null]) {
  const initial = new Map([
    [true, 1],
    [false, 2],
    [null, null],
  ]).get(locked);
  mappings.push({
    id: `lock-${locked}`,
    class: 'lock',
    source: 'closures/DoorLockCluster.mts',
    capabilities: { locked: capability(locked, { type: 'boolean', setable: true }) },
    endpoints: [{ id: 'main', type: 0xa }],
    attributes: [
      attribute('locked', 'DoorLock', 'lockState', initial, [
        [true, 1],
        [false, 2],
        [null, null],
      ]),
    ],
    commands: [
      command('DoorLock', 'lockDoor', {}, { locked: true }),
      command('DoorLock', 'unlockDoor', {}, { locked: false }),
    ],
  });
}
mappings.push({
  id: 'position-cover',
  class: 'windowcoverings',
  source: 'closures/WindowCoveringCluster.mts',
  capabilities: { windowcoverings_set: capability(0.25, { setable: true, min: 0, max: 1 }) },
  endpoints: [
    {
      id: 'main',
      type: 0x202,
      features: { WindowCovering: { lift: true, positionAwareLift: true } },
    },
  ],
  attributes: [
    attribute('windowcoverings_set', 'WindowCovering', 'currentPositionLiftPercent100ths', 7500, [
      [0, 10000],
      [1, 0],
      [0.12345, 8765],
      [null, null],
    ]),
  ],
  commands: [
    command(
      'WindowCovering',
      'goToLiftPercentage',
      { liftPercent100thsValue: 2500 },
      { windowcoverings_set: 0.75 },
    ),
    command('WindowCovering', 'upOrOpen', {}, { windowcoverings_set: 1 }),
    command('WindowCovering', 'downOrClose', {}, { windowcoverings_set: 0 }),
  ],
});
mappings.push({
  id: 'state-cover',
  class: 'windowcoverings',
  source: 'closures/WindowCoveringCluster.mts',
  capabilities: {
    windowcoverings_state: capability('up', {
      setable: true,
      type: 'enum',
      values: ['up', 'down', 'idle'].map((id) => {
        return { id };
      }),
    }),
  },
  endpoints: [
    {
      id: 'main',
      type: 0x202,
      features: { WindowCovering: { lift: true, positionAwareLift: false } },
    },
  ],
  attributes: [
    attribute(
      'windowcoverings_state',
      'WindowCovering',
      'operationalStatus',
      { global: 1, lift: 1, tilt: 0 },
      [
        ['up', { global: 1, lift: 1, tilt: 0 }],
        ['down', { global: 2, lift: 2, tilt: 0 }],
        ['idle', { global: 0, lift: 0, tilt: 0 }],
      ],
    ),
  ],
  commands: [
    command('WindowCovering', 'upOrOpen', {}, { windowcoverings_state: 'up' }),
    command('WindowCovering', 'downOrClose', {}, { windowcoverings_state: 'down' }),
    command('WindowCovering', 'stopMotion', {}, { windowcoverings_state: 'idle' }),
  ],
});

const sensors = [
  [
    'measure_temperature',
    20.25,
    'TemperatureMeasurement',
    0x302,
    2025,
    [
      [0, 0],
      [-5.5, -550],
      [null, null],
    ],
    '°C',
  ],
  [
    'measure_humidity',
    45.5,
    'RelativeHumidityMeasurement',
    0x307,
    4550,
    [
      [0, 0],
      [100, 10000],
      [null, null],
    ],
    '%',
  ],
  [
    'measure_co',
    5,
    'CarbonMonoxideConcentrationMeasurement',
    0x2c,
    5,
    [
      [0, 0],
      [12.5, 12.5],
      [null, null],
    ],
    'ppm',
  ],
  [
    'measure_co2',
    400,
    'CarbonDioxideConcentrationMeasurement',
    0x2c,
    400,
    [
      [0, 0],
      [512.5, 512.5],
      [null, null],
    ],
    'ppm',
  ],
  [
    'measure_pm10',
    10,
    'Pm10ConcentrationMeasurement',
    0x2c,
    10,
    [
      [0, 0],
      [12.5, 12.5],
      [null, null],
    ],
    'µg/m³',
  ],
  [
    'measure_pm25',
    5,
    'Pm25ConcentrationMeasurement',
    0x2c,
    5,
    [
      [0, 0],
      [12.5, 12.5],
      [null, null],
    ],
    'µg/m³',
  ],
  [
    'measure_luminance',
    100,
    'IlluminanceMeasurement',
    0x106,
    20001,
    [
      [0, 0],
      [10, 10001],
      [null, null],
    ],
    'lx',
  ],
  [
    'alarm_contact',
    false,
    'BooleanState',
    0x15,
    true,
    [
      [true, false],
      [false, true],
    ],
  ],
  [
    'alarm_motion',
    false,
    'OccupancySensing',
    0x107,
    { occupied: false },
    [
      [true, { occupied: true }],
      [false, { occupied: false }],
    ],
  ],
  [
    'alarm_occupancy',
    false,
    'OccupancySensing',
    0x107,
    { occupied: false },
    [
      [true, { occupied: true }],
      [false, { occupied: false }],
    ],
  ],
  [
    'alarm_smoke',
    true,
    'SmokeCoAlarm',
    0x76,
    2,
    [
      [false, 0],
      [true, 2],
    ],
  ],
];
for (const [id, value, cluster, type, initial, updates, units] of sensors) {
  const names = {
    BooleanState: 'stateValue',
    OccupancySensing: 'occupancy',
    SmokeCoAlarm: 'smokeState',
  };
  const sources = {
    BooleanState: 'general/BooleanStateCluster.mts',
    OccupancySensing: 'measurement-and-sensing/OccupancySensingCluster.mts',
    SmokeCoAlarm: 'measurement-and-sensing/SmokeCOAlarmCluster.mts',
  };
  const attributes = [
    attribute(id, cluster, names[cluster] ?? 'measuredValue', initial, updates, id),
  ];
  if (id === 'alarm_smoke') {
    attributes.push(
      attribute(
        id,
        cluster,
        'expressedState',
        1,
        [
          [false, 0],
          [true, 1],
        ],
        id,
      ),
    );
  }
  mappings.push({
    id,
    class: 'sensor',
    source: sources[cluster] ?? 'measurement-and-sensing/MeasurementClusters.mts',
    capabilities: { [id]: capability(value, { units }) },
    endpoints: [{ id, type }],
    attributes,
    commands: [],
  });
}
mappings.push({
  id: 'fallback',
  class: 'other',
  source: 'general/OnOffCluster.mts',
  capabilities: { onoff: capability(true, { setable: true }) },
  endpoints: [{ id: 'main', type: 0x10a }],
  attributes: [onoff],
  commands: onoffCommands,
});

for (const [id, sourceId, deviceClass, virtualClass] of [
  ['heatpump', 'thermostat-off-heat', 'heatpump'],
  ['heater', 'thermostat-implicit', 'heater'],
  ['airconditioning', 'thermostat-off-heat-cool-auto', 'airconditioning'],
  ['blinds', 'position-cover', 'blinds'],
  ['shutterblinds', 'position-cover', 'shutterblinds'],
  ['curtain', 'state-cover', 'curtain'],
  ['virtual-light', 'light-dimmable', 'socket', 'light'],
]) {
  const fixture = structuredClone(
    mappings.find((item) => {
      return item.id === sourceId;
    }),
  );
  Object.assign(fixture, { id, class: deviceClass, virtualClass });
  if (deviceClass === 'airconditioning') {
    fixture.endpoints[0].type = 0x72;
    fixture.capabilities.onoff = capability(true, { setable: true });
    fixture.attributes.push(onoff);
    fixture.commands.push(...onoffCommands);
  }
  mappings.push(fixture);
}
const combined = structuredClone(
  mappings.find((item) => {
    return item.id === 'light-color';
  }),
);
combined.id = 'light-with-sensors';
for (const id of ['measure_co2', 'alarm_occupancy']) {
  const fixture = mappings.find((item) => {
    return item.id === id;
  });
  Object.assign(combined.capabilities, fixture.capabilities);
  combined.endpoints.push(...fixture.endpoints);
  combined.attributes.push(...fixture.attributes);
}
mappings.push(combined);

// Cluster IDs are the independent discovery contract for the pinned Matter model.
const clusterIds = {
  Identify: 3,
  Groups: 4,
  Descriptor: 29,
  ScenesManagement: 98,
  AirQuality: 91,
  OnOff: 6,
  LevelControl: 8,
  ColorControl: 768,
  Thermostat: 513,
  DoorLock: 257,
  WindowCovering: 258,
  ElectricalPowerMeasurement: 144,
  TemperatureMeasurement: 1026,
  RelativeHumidityMeasurement: 1029,
  CarbonMonoxideConcentrationMeasurement: 1036,
  CarbonDioxideConcentrationMeasurement: 1037,
  Pm10ConcentrationMeasurement: 1069,
  Pm25ConcentrationMeasurement: 1066,
  IlluminanceMeasurement: 1024,
  BooleanState: 69,
  OccupancySensing: 1030,
  SmokeCoAlarm: 92,
};
for (const fixture of mappings) {
  for (const endpoint of fixture.endpoints) {
    endpoint.features ??= {};
    endpoint.values = {};
    const clusters = new Set([3, 29]); // Identify and Descriptor
    for (const check of fixture.attributes) {
      if (check.endpoint !== endpoint.id) {
        continue;
      }
      clusters.add(clusterIds[check.cluster]);
      if (check.cluster.includes('ConcentrationMeasurement')) {
        endpoint.features[check.cluster] = { numericMeasurement: true };
        endpoint.values[check.cluster] = {
          measurementUnit: check.capabilityId.startsWith('measure_pm') ? 4 : 0,
          measurementMedium: 0,
        };
      }
      if (check.cluster === 'OccupancySensing') {
        endpoint.features.OccupancySensing =
          check.capabilityId === 'alarm_motion' ? { passiveInfrared: true } : { ultrasonic: true };
      }
      if (check.cluster === 'SmokeCoAlarm') {
        endpoint.features.SmokeCoAlarm = { smokeAlarm: true };
      }
      if (check.cluster === 'Thermostat' && check.name.includes('Setpoint')) {
        const kind = check.name.includes('Cooling') ? 'Cool' : 'Heat';
        endpoint.values.Thermostat ??= {};
        Object.assign(endpoint.values.Thermostat, {
          [`min${kind}SetpointLimit`]: 1600,
          [`max${kind}SetpointLimit`]: 3000,
        });
      }
      if (check.cluster === 'ColorControl' && check.capabilityId === 'light_temperature') {
        endpoint.values.ColorControl = {
          colorTempPhysicalMinMireds: 1,
          colorTempPhysicalMaxMireds: 300,
        };
      }
    }
    if ([0x100, 0x101, 0x10a, 0x10c, 0x10d].includes(endpoint.type)) {
      clusters.add(4); // Groups
      clusters.add(98); // Scenes Management
    }
    if (endpoint.type === 0x2c) {
      clusters.add(91);
    } // Air Quality
    if (endpoint.type === 0x72) {
      clusters.add(6);
    } // Room AC requires On/Off
    endpoint.clusters = [...clusters].sort((a, b) => {
      return a - b;
    });
    for (const [cluster, id] of Object.entries(clusterIds)) {
      if (!clusters.has(id) || endpoint.features[cluster]) {
        continue;
      }
      const defaults = {
        Groups: { groupNames: true },
        ScenesManagement: { sceneNames: true },
        BooleanState: { changeEvent: true },
        // Custom OnOff handlers currently advertise basic on/off; extended features are tracked gaps.
        OnOff: {},
        LevelControl: { onOff: true, lighting: true },
      };
      endpoint.features[cluster] = defaults[cluster] ?? {};
    }
  }
}
