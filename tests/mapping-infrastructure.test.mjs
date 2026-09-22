import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Rpc } from './mappings/Rpc.mjs';
import { BridgeHarness } from './mappings/BridgeHarness.mjs';
import { selectMappings } from './mappings/selectMappings.mjs';

function createChannels() {
  const channels = [new EventEmitter(), new EventEmitter()];

  for (const [index, channel] of channels.entries()) {
    channel.send = (message, callback) => {
      const payload = structuredClone(message);
      queueMicrotask(() => {
        channels[1 - index].emit('message', payload);
        callback();
      });
    };
  }

  return channels;
}

test('mapping RPC preserves results and remote error causes', async () => {
  const [local, remote] = createChannels();
  const rpc = new Rpc(local, async () => {});
  new Rpc(remote, async (method, args) => {
    if (method === 'reject') {
      throw new Error('Capability rejected', { cause: new Error('Driver unavailable') });
    }
    return args;
  });

  assert.deepEqual(await rpc.call('echo', { hex: '040001ff', value: null }), {
    hex: '040001ff',
    value: null,
  });
  await assert.rejects(rpc.call('reject'), (error) => {
    assert.equal(error.message, 'Capability rejected');
    assert.equal(error.cause.message, 'Driver unavailable');
    return true;
  });
});

test('mapping RPC rejects pending and future calls after disconnect', async () => {
  const channel = new EventEmitter();
  channel.send = () => {};
  const rpc = new Rpc(channel, async () => {});
  const pending = rpc.call('snapshot');

  channel.emit('disconnect');

  await assert.rejects(pending, /IPC disconnected/);
  await assert.rejects(rpc.call('snapshot'), /IPC disconnected/);
});

test('mapping RPC observes asynchronous send failures', async () => {
  const channel = new EventEmitter();
  channel.send = (message, callback) => {
    queueMicrotask(() => {
      callback(new Error('IPC channel closed'));
    });
  };
  const rpc = new Rpc(channel, async () => {});

  await assert.rejects(rpc.call('snapshot'), /IPC channel closed/);
});

test('a misspelled mapping filter fails instead of reporting an empty passing run', () => {
  assert.throws(() => {
    selectMappings([{ id: 'socket' }], 'socket,sokcet');
  }, /Unknown MAPPING_CASE: sokcet/);
});

test('mapping cleanup releases remaining resources after a subscription close fails', async () => {
  const harness = new BridgeHarness();
  const calls = [];
  const failure = new Error('Subscription close failed');
  harness.subscription = {
    close: async () => {
      throw failure;
    },
  };
  harness.controller = {
    peers: {
      close: async () => {
        calls.push('peers');
      },
    },
    close: async () => {
      calls.push('controller');
    },
  };
  harness.bridge = {
    stop: async () => {
      calls.push('bridge');
    },
  };

  await assert.rejects(harness.close(), (error) => {
    assert.equal(error.errors[0], failure);
    return true;
  });
  assert.deepEqual(calls, ['peers', 'controller', 'bridge']);
});
