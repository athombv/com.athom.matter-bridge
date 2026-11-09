import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../../tests/fixtures/homey-app/app.json' with { type: 'json' };
import profiles from '../../tests/fixtures/homey-app/profiles.json' with { type: 'json' };

/** Materialize SDK driver entry points from the same catalogue used by tests. */
export async function prepareFixtureApp(directory) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  await cp(join(root, 'tests/fixtures/homey-app'), directory, { recursive: true });
  await cp(join(root, 'assets/images'), join(directory, 'assets/images'), { recursive: true });
  const drivers = [];

  for (const [id, profile] of Object.entries(profiles)) {
    const driverDirectory = join(directory, 'drivers', id);
    await mkdir(driverDirectory, { recursive: true });
    await writeFile(join(driverDirectory, 'driver.js'), "const { FixtureDriver } = require('../../lib/FixtureDriver');\nclass Driver extends FixtureDriver {}\nmodule.exports = Driver;\n");
    await cp(join(directory, 'assets/icon.svg'), join(driverDirectory, 'assets/icon.svg'));
    drivers.push({
      id,
      name: { en: `Fixture ${id}` },
      class: profile.class,
      capabilities: Object.keys(profile.values),
      capabilitiesOptions: profile.options ?? {},
      images: manifest.images,
      pair: [
        { id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } },
        { id: 'add_devices', template: 'add_devices' },
      ],
    });
  }

  await writeFile(join(directory, 'app.json'), `${JSON.stringify({ ...manifest, drivers }, null, 2)}\n`);
}
