// fail: <message> -- stops the run with that message (templated). Used with
// `when` to end a run deliberately, e.g. "this node has 10.0.0.9, not the
// expected original 10.0.0.5".

function validate(message) {
  return typeof message === 'string' && message.trim() ? [] : ['fail needs a message'];
}

async function run(message, rt) {
  throw new Error(String(rt.render(message)));
}

module.exports = { key: 'fail', validate, run };
