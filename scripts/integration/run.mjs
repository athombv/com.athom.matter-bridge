import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { appendFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHS_IMAGE } from './config.mjs';
import { createSeed } from './seed.mjs';
import { prepareFixtureApp } from './fixture-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'output/integration');
const labFile = join(output, 'lab.json');
const owner = createHash('sha256').update(root).digest('hex').slice(0, 10);
const [command = 'test', ...args] = process.argv.slice(2);
let child;
let interrupted = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    child?.kill('SIGTERM');
  });
}

async function run(executable, parameters, { cwd = root, log, quiet = false, timeout = 180000 } = {}) {
  const stream = log ? createWriteStream(log, { flags: 'a' }) : undefined;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const running = spawn(executable, parameters, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  child = running;
  const timer = setTimeout(() => {
    timedOut = true;
    running.kill('SIGKILL');
  }, timeout);

  running.stdout.on('data', (data) => {
    stdout += data;
    stream?.write(data);

    if (!quiet) {
      process.stdout.write(data);
    }
  });
  running.stderr.on('data', (data) => {
    stderr = `${stderr}${data}`.slice(-2000);
    stream?.write(data);

    if (!quiet) {
      process.stderr.write(data);
    }
  });

  try {
    await new Promise((resolve, reject) => {
      running.once('error', reject);
      running.once('close', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }

        const reason = timedOut ? 'timeout' : signal ?? code;
        const detail = log ? `see ${log}` : stderr.trim();
        reject(new Error(`${executable} failed (${reason}): ${detail}`));
      });
    });
  } finally {
    clearTimeout(timer);
    child = undefined;

    if (stream) {
      await new Promise((resolve) => { stream.end(resolve); });
    }
  }

  return stdout.trim();
}

async function inspect(kind, name) {
  try {
    return JSON.parse(await run('docker', [kind, 'inspect', name], { quiet: true }))[0];
  } catch {
    return undefined;
  }
}

async function cleanup(state) {
  for (const name of [state.worker, state.proxy, state.container]) {
    const container = await inspect('container', name);

    if (container?.Config.Labels?.['matter-bridge.integration'] === owner) {
      await run('docker', ['rm', '-f', name], { quiet: true });
    }
  }

  for (const [kind, name] of [['volume', state.volume], ['network', state.network]]) {
    const resource = await inspect(kind, name);

    if (resource?.Labels?.['matter-bridge.integration'] === owner) {
      await run('docker', [kind, 'rm', name], { quiet: true });
    }
  }
}

async function captureLogs(state) {
  if (await inspect('container', state.container)) {
    await run('docker', ['logs', '--timestamps', state.container], { log: join(state.directory, 'homey-shs.log'), quiet: true });
  }
}

async function build(state, ref) {
  const staging = join(state.directory, 'source');
  const log = join(state.directory, 'build.log');
  await mkdir(staging);

  if (ref) {
    const archive = join(state.directory, 'source.tar');
    await run('git', ['archive', '--format=tar', `--output=${archive}`, ref], { quiet: true });
    await run('tar', ['-xf', archive, '-C', staging], { quiet: true });
    await rm(archive);
  } else {
    // Include local edits and untracked source, but respect .gitignore.
    const paths = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { quiet: true });

    for (const path of new Set(paths.split('\0').filter(Boolean))) {
      try {
        await cp(join(root, path), join(staging, path), { recursive: true });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  // Also enforce this boundary when packaging older refs without these exclusions.
  await appendFile(join(staging, '.homeyignore'), '\ntests/\nscripts/\ndocs/\noutput/\n.github/\n');
  console.log(`Building app from ${ref ?? 'the working tree'}…`);
  await run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: staging, log, quiet: true });
  await run('homey', ['app', 'build'], { cwd: staging, log, quiet: true });
  await run('tar', ['-czf', join(state.directory, 'app.tar.gz'), '-C', join(staging, '.homeybuild'), '.'], { quiet: true });
  state.source = {
    ref: ref ?? 'working tree',
    commit: await run('git', ['rev-parse', ref ?? 'HEAD'], { quiet: true }),
    dirty: ref ? false : (await run('git', ['status', '--porcelain'], { quiet: true })).length > 0,
  };
  await rm(staging, { recursive: true });

  const fixtureDirectory = join(state.directory, 'fixture-source');
  await prepareFixtureApp(fixtureDirectory);
  await run('homey', ['app', 'build'], { cwd: fixtureDirectory, log, quiet: true });
  await run('tar', ['-czf', join(state.directory, 'fixtures.tar.gz'), '-C', join(fixtureDirectory, '.homeybuild'), '.'], { quiet: true });
  await rm(fixtureDirectory, { recursive: true });
}

async function worker(state, parameters, { log, quiet = false, timeout = 180000 } = {}) {
  await run('docker', ['run', '--rm', '--name', state.worker,
    '--label', `matter-bridge.integration=${owner}`, '--network', `container:${state.container}`,
    '--volume', `${root}:/workspace:ro`, '--volume', `${state.directory}:/output`,
    '--workdir', '/workspace', state.image, 'node', ...parameters,
  ], { log, quiet, timeout });
}

async function start(state) {
  const labels = ['--label', `matter-bridge.integration=${owner}`];

  // Refresh mutable tags, then keep every container in this run on the same image.
  await run('docker', ['pull', state.imageReference], { log: join(state.directory, 'image.log') });
  const images = JSON.parse(await run('docker', ['image', 'inspect', state.imageReference], { quiet: true }));
  state.image = images[0].Id;
  state.imageDigests = images[0].RepoDigests;
  console.log(`SHS image: ${state.imageReference} resolved to ${state.image}`);

  createSeed(join(state.directory, 'seed'));
  await run('docker', ['volume', 'create', ...labels, state.volume], { quiet: true });
  await run('docker', ['run', '--rm', '--network', 'none',
    '--volume', `${join(state.directory, 'seed')}:/seed:ro`, '--volume', `${state.volume}:/data`,
    state.image, 'cp', '-a', '/seed/.', '/data/'], { quiet: true });
  const subnet = `fd42:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::/64`;
  await run('docker', ['network', 'create', ...labels, '--internal', '--ipv6', '--subnet', subnet, state.network], { quiet: true });
  await run('docker', ['run', '--detach', '--name', state.container, ...labels,
    '--network', state.network, '--privileged', '--volume', `${state.volume}:/homey/user`,
    '--env', 'HOMEY_LOCAL_ADDRESS=127.0.0.1', '--env', 'HOMEY_APP_LOG_TO_CONSOLE=1',
    state.image], { quiet: true });
  console.log('Starting isolated SHS and installing the packaged app…');
  await worker(state, ['scripts/integration/backend.mjs', 'install'], { log: join(state.directory, 'setup.log'), timeout: 300000 });
}

async function exposeLab(state) {
  const container = await inspect('container', state.container);
  const address = container.NetworkSettings.Networks[state.network].IPAddress;
  await run('docker', ['create', '--name', state.proxy, '--label', `matter-bridge.integration=${owner}`,
    '--network', 'bridge', '--publish', '127.0.0.1::4859',
    '--env', `SHS_ADDRESS=${address}`, '--volume', `${root}:/workspace:ro`,
    state.image, 'node', '/workspace/scripts/integration/proxy.mjs'], { quiet: true });
  await run('docker', ['network', 'connect', state.network, state.proxy], { quiet: true });
  await run('docker', ['start', state.proxy], { quiet: true });
  const proxy = await inspect('container', state.proxy);
  state.url = `http://127.0.0.1:${proxy.NetworkSettings.Ports['4859/tcp'][0].HostPort}`;
}

async function loadLab() {
  try {
    return JSON.parse(await readFile(labFile, 'utf8'));
  } catch (error) {
    throw new Error('No lab manifest found. Start one with npm run shs -- up.', { cause: error });
  }
}

async function main() {
  if (command === 'help' || command === '--help') {
    console.log('npm run shs -- up|down|logs|devices');
    console.log('npm run shs -- set|report <name> <capability> <JSON>');
    console.log('npm run shs -- availability <name> <true|false>');
    console.log('npm run shs -- reject <name> <capability> <true|false>');
    console.log('npm run shs -- commands <name>');
    console.log('npm run test:integration -- [--scenario smoke|reshare|fixtures|devices|power|restart] [--ref <git-ref>]');
    console.log('up also accepts --ref. Test runs are fresh and always cleaned up; up retains a separate lab.');
    return;
  }

  if (['down', 'logs', 'devices', 'set', 'report', 'availability', 'reject', 'commands'].includes(command)) {
    const state = await loadLab();

    if (command === 'down') {
      await captureLogs(state);
      await cleanup(state);
      await rm(labFile);
      console.log(`Lab removed. Reports retained at ${state.directory}`);
      return;
    }

    if (command === 'logs') {
      await run('docker', ['logs', '--follow', '--timestamps', state.container], { timeout: 86400000 });
      return;
    }

    await worker(state, ['scripts/integration/backend.mjs', command, ...args]);
    return;
  }

  if (!['up', 'test'].includes(command)) {
    throw new Error(`Unknown command: ${command}; use --help`);
  }

  let ref;
  let scenario = 'smoke';

  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];

    if (!value) {
      throw new Error(`Missing value for ${args[index]}`);
    }

    if (args[index] === '--ref') {
      ref = value;
    } else if (args[index] === '--scenario' && command === 'test') {
      scenario = value;
    } else {
      throw new Error(`Unknown option: ${args[index]}`);
    }
  }

  if (!['smoke', 'reshare', 'fixtures', 'devices', 'power', 'restart'].includes(scenario)) {
    throw new Error(`Unknown scenario: ${scenario}`);
  }

  await mkdir(output, { recursive: true });

  if (command === 'up') {
    try {
      await readFile(labFile);
      throw new Error('A lab already exists; use npm run shs -- down before replacing it.');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const id = `matter-bridge-${owner}-${randomUUID().slice(0, 8)}`;
  const state = {
    container: id, network: id, volume: id, worker: `${id}-worker`, proxy: `${id}-proxy`,
    directory: join(output, id), imageReference: process.env.HOMEY_SHS_IMAGE ?? SHS_IMAGE,
  };
  await mkdir(state.directory);
  const startedAt = new Date().toISOString();
  let outcome = 'FAIL';
  let retained = false;
  let failure;

  try {
    await run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
    await build(state, ref);
    await start(state);

    if (command === 'up') {
      await worker(state, ['scripts/integration/backend.mjs', 'fixtures']);
      await exposeLab(state);
      await writeFile(labFile, `${JSON.stringify(state, null, 2)}\n`);
      retained = true;
      console.log(`Lab ready at ${state.url}; driver-backed fixture devices are shared`);
    } else {
      console.log(`Running ${scenario} integration scenario…`);
      await worker(state, ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout',
        '--test-reporter=junit', '--test-reporter-destination=/output/results.xml',
        `tests/integration/${scenario}.test.mjs`,
      ], { log: join(state.directory, 'tests.log') });
    }

    if (interrupted) {
      throw new Error('Interrupted');
    }

    outcome = 'PASS';
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors = [];

    try {
      await captureLogs(state);
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (!retained) {
      try {
        await cleanup(state);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length) {
      outcome = 'FAIL';
    }

    await writeFile(join(state.directory, 'result.json'), `${JSON.stringify({
      outcome, error: failure?.message, command, scenario, source: state.source,
      imageReference: state.imageReference, image: state.image, imageDigests: state.imageDigests,
      startedAt, finishedAt: new Date().toISOString(),
      cleanupErrors: cleanupErrors.map((error) => { return error.message; }),
    }, null, 2)}\n`);
    console.log(`Logs and results: ${state.directory}`);

    if (cleanupErrors.length) {
      const errors = failure ? [failure, ...cleanupErrors] : cleanupErrors;
      throw new AggregateError(errors, 'Failed to capture logs or clean up the integration environment');
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = interrupted ? 130 : 1;
}
