// Minimal per-key async mutex. Node is single-threaded, but that only
// serializes synchronous work -- any `await` inside a "read current state,
// decide what's free, then create/write it" sequence (VMID allocation,
// bridge-number allocation, a lab's deploy/destroy/update) is exactly where
// two concurrent callers can both pass a check that only one of them should
// have. Found via a full-app review: none of those call sites had any
// locking at all, real for this app now that multi-user login is a shipped
// feature (two users, or the same user in two tabs, hitting the same
// operation at once).
//
// Deliberately just a promise-chain queue, not a real semaphore/npm
// dependency -- one process, homelab scale, no need for anything fancier.
const tails = new Map(); // key -> tail promise of that key's queue

function withLock(key, fn) {
  const prevTail = tails.get(key) || Promise.resolve();
  // Run fn after whatever's ahead of it settles, regardless of whether that
  // prior call succeeded or threw -- one failed deploy() must not wedge
  // every later call queued behind it on the same key.
  const runPromise = prevTail.then(fn, fn);
  const tailPromise = runPromise.catch(() => {});
  tails.set(key, tailPromise);
  tailPromise.finally(() => {
    // Only delete if nothing queued behind us in the meantime -- avoids
    // dropping a live tail that a concurrent caller just chained onto.
    if (tails.get(key) === tailPromise) tails.delete(key);
  });
  return runPromise;
}

function isLocked(key) {
  return tails.has(key);
}

module.exports = { withLock, isLocked };
