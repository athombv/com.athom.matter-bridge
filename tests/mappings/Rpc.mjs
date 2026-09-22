// Duplex process IPC keeps protocol payloads separate from backend diagnostic output.
export class Rpc {
  #channel;
  #pending = new Map();
  #sequence = 0;
  #failure;

  constructor(channel, handler) {
    this.#channel = channel;
    channel.on('message', (message) => {
      this.#receive(message, handler).catch((error) => {
        this.#fail(error);
      });
    });
    channel.on('disconnect', () => {
      this.#fail(new Error('Backend IPC disconnected'));
    });
    channel.on('error', (error) => {
      this.#fail(error);
    });
  }

  call(method, args = {}) {
    if (this.#failure) {
      return Promise.reject(this.#failure);
    }

    const id = this.#sequence++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`IPC timeout: ${method}`));
      }, 30000);

      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ id, method, args });
    });
  }

  async #receive(message, handler) {
    if (message.ready) {
      return;
    }

    if (message.reply !== undefined) {
      const pending = this.#pending.get(message.reply);
      if (!pending) {
        return;
      }

      this.#pending.delete(message.reply);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(Rpc.#decodeError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    try {
      const result = await handler(message.method, message.args);
      this.#send({ reply: message.id, result });
    } catch (error) {
      this.#send({ reply: message.id, error: Rpc.#encodeError(error) });
    }
  }

  #send(message) {
    try {
      this.#channel.send(message, (error) => {
        if (error) {
          this.#fail(error);
        }
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  #fail(error) {
    this.#failure ??= error;

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  static #encodeError(error) {
    if (!(error instanceof Error)) {
      return { message: String(error) };
    }

    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
      cause: error.cause === undefined ? undefined : Rpc.#encodeError(error.cause),
    };
  }

  static #decodeError(payload) {
    const cause = payload.cause === undefined ? undefined : Rpc.#decodeError(payload.cause);
    const error = new Error(payload.message, { cause });
    error.name = payload.name ?? 'Error';
    error.stack = payload.stack ?? error.stack;
    return error;
  }
}
