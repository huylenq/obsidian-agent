/**
 * Creates an externally-pushable AsyncIterable — like an RxJS Subject but
 * for async iterators.  Values are queued if no consumer is waiting;
 * a waiting consumer is resolved immediately when push() is called.
 *
 * Usage:
 *   const { iterable, push, close } = createAsyncIterableController();
 *   push(value);          // enqueue or resolve a pending consumer
 *   close();              // signal completion
 *   for await (const v of iterable) { ... }
 */
export function createAsyncIterableController() {
  const queue = [];     // buffered values not yet consumed
  const waiters = [];   // pending resolve callbacks from next()
  let done = false;

  function push(value) {
    if (done) return;
    if (waiters.length > 0) {
      // A consumer is already waiting — resolve it immediately
      const resolve = waiters.shift();
      resolve({ value, done: false });
    } else {
      queue.push(value);
    }
  }

  function close() {
    if (done) return;
    done = true;
    // Flush any waiting consumers with { done: true }
    while (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve({ value: undefined, done: true });
    }
  }

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          // Park until push() or close() is called
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return() {
          close();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return { iterable, push, close };
}
