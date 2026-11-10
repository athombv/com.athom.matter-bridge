import fixtureManifest from '../../tests/fixtures/homey-app/app.json' with { type: 'json' };

// Test-only identity. Never use an activated household Homey as a seed.
export const TEST_USERNAME = 'bridge-test';
export const TEST_PASSWORD = 'bridge-test';
export const SHS_IMAGE = 'ghcr.io/athombv/homey-shs:latest';
export const APP_ID = 'com.athom.matter-bridge';
export const FIXTURE_APP_ID = fixtureManifest.id;
