import { scryptSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TEST_PASSWORD, TEST_USERNAME } from './config.mjs';

/** Generate five synthetic bootstrap records from literals, without importing a database. */
export function createSeed(directory) {
  const sqlite = join(directory, 'sqlite');
  mkdirSync(sqlite, { recursive: true });
  const database = new DatabaseSync(join(sqlite, 'db.sqlite'));
  const timestamp = '2026-01-01T00:00:00.000Z';
  const salt = Buffer.from('matter-bridge-e2e');
  const hash = scryptSync(TEST_PASSWORD, salt, 64).toString('base64');
  const password = `scrypt$N=16384,r=8,p=1,keylen=64$${salt.toString('base64')}$${hash}`;
  const records = [
    ['setup', 'config', {
      homeyId: '000000000000000000000040',
      homeySerial: 'shs-00000000000000000000000000000040',
      homeyName: 'Matter Bridge Integration',
      homeyTimezone: 'Etc/UTC', homeyLanguage: 'en', homeyCountry: 'NL',
      homeyVersion: '13.4.1', homeySetup: null,
    }],
    ['user', '00000000-0000-4000-8000-000000000001', {
      name: 'Integration Test Owner', role: 'owner',
      athomId: '000000000000000000000041', properties: {},
      enabled: true, enabledUntil: null, present: true, asleep: false,
      inviteUrl: null, inviteToken: null,
      localUsername: TEST_USERNAME, localPassword: password,
      createdAt: timestamp, updatedAt: Date.parse(timestamp),
    }],
    ['zone', '00000000-0000-4000-8000-000000000002', {
      name: 'Test Home', icon: 'home', parent: null,
      activeOrigins: [], activeLastUpdated: null,
      createdAt: Date.parse(timestamp), updatedAt: Date.parse(timestamp),
    }],
    ['experiment-poweruser', 'default', { enabled: true, createdAt: timestamp, updatedAt: Date.parse(timestamp) }],
    ['experiment-virtualdevices', 'default', { enabled: true, createdAt: timestamp, updatedAt: Date.parse(timestamp) }],
  ];

  try {
    // Refuse an existing database instead of modifying arbitrary Homey state.
    database.exec('CREATE TABLE Entry (type VARCHAR(255) NOT NULL, id VARCHAR(255) NOT NULL, value JSON, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL, PRIMARY KEY (type, id))');
    const insert = database.prepare('INSERT INTO Entry VALUES (?, ?, ?, ?, ?)');

    for (const [type, id, value] of records) {
      insert.run(type, id, JSON.stringify(value), timestamp, timestamp);
    }
  } finally {
    database.close();
  }
}
