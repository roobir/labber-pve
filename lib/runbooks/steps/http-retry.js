// `retry` for an http step that is not a poll: repeat the SAME request while
// the device says it is not ready for it yet, then judge the final response
// against `expect` as usual.
//
//   retry: { on: [404, 503], match: 'provisioning operation is in progress',
//            every: 10, timeout: 600 }
//
// A request is retried if it fails to connect, its status is in `on`, or its
// body matches the `match` regex. `poll` waits for a condition to become true;
// `retry` is for "the device was busy, ask again".

function validate(retry) {
  if (!retry || typeof retry !== 'object') return ['http.retry must be an object'];
  const errors = [];
  if (!(retry.every > 0 && retry.timeout > 0)) errors.push('http.retry needs every and timeout (seconds)');
  if (!retry.on && !retry.match) errors.push('http.retry needs on (status codes) and/or match (regex)');
  if (retry.on !== undefined && !Array.isArray(retry.on)) errors.push('http.retry.on must be a list of status codes');
  try {
    if (retry.match) new RegExp(retry.match, 'i');
  } catch (e) {
    errors.push(`http.retry.match is not a valid regex (${e.message})`);
  }
  return errors;
}

async function withRetry(attemptOnce, retry, rt) {
  if (!retry) return attemptOnce();
  const { on = [], match, every, timeout } = retry;
  const matcher = match ? new RegExp(match, 'i') : null;
  const deadline = Date.now() + timeout * 1000;

  for (let n = 1; ; n++) {
    let res = null;
    let failure = null;
    try {
      res = await attemptOnce();
    } catch (err) {
      if (err.message === 'aborted') throw err;
      failure = err;
    }
    const busy = failure || on.includes(res.status) || (matcher && matcher.test(res.body));
    if (!busy) return res;

    rt.log(`retry #${n}: ${failure ? failure.code || failure.message : `HTTP ${res.status}, device not ready`}`);
    if (Date.now() + every * 1000 > deadline) {
      if (failure) throw failure;
      return res; // out of time: let `expect` report the device's own answer
    }
    await rt.sleep(every * 1000);
  }
}

module.exports = { validate, withRetry };
