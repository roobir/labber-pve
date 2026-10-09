// wait: <seconds> -- plain pause, e.g. to let a service settle.

function validate(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? [] : ['wait must be a positive number of seconds'];
}

async function run(seconds, rt) {
  rt.log(`waiting ${seconds}s`);
  await rt.sleep(seconds * 1000);
  return { out: {} };
}

module.exports = { key: 'wait', validate, run };
