// Defer synchronous setup and adopt the callback's result or rejection in one observable promise.
export function runInMicrotask(callback) {
  return Promise.resolve().then(callback);
}
