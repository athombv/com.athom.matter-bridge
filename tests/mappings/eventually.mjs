import { setTimeout as delay } from 'node:timers/promises';

export async function eventually(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let error;

  do {
    try {
      return await check();
    } catch (caught) {
      error = caught;
    }

    await delay(20);
  } while (Date.now() < deadline);

  throw new Error(`${message}: ${error?.message}`, { cause: error });
}
