// Serial-console step: a list of actions run in order against the target
// node's console. Each action may expect (wait for output matching a
// regex), send (type a line), and/or sleep:
//
//   console:
//     - expect: "login:"        # case-insensitive regex
//       timeout: 900            # seconds (default 60)
//       nudge: 10               # send a newline every 10s while waiting
//       send: root              # typed + Enter once the expect matches
//     - expect: "(\\d+\\.\\d+\\.\\d+\\.\\d+)/"
//       as: ip                  # captured group 1 -> {{steps.<id>.out.ip}}
//     - expect: "Retype"
//       optional: true          # no match within timeout = skip this whole action
//                               # (including its `send`) and carry on
//     - paste: |                # type a block of lines (a config), one per line
//         config system interface
//         edit port1
//         end
//       failOn: "command parse error|Command fail"   # regex: abort if the device prints this
//       lineDelay: 0.03         # seconds between lines (default 0.03)
//       settle: 5               # seconds of silence = the device has finished (default 5)
//
// `send` appends Enter (\r) unless `raw: true`; escapes like "\x03"
// (Ctrl-C) work in double-quoted YAML.

const DEFAULT_TIMEOUT_S = 60;
const SEND_DELAY_MS = 200; // pacing: appliance login shells drop fast input
const ACTION_KEYS = ['expect', 'send', 'sleep', 'paste'];
const DEFAULT_LINE_DELAY_S = 0.03;
const DEFAULT_SETTLE_S = 5;
const DEFAULT_PASTE_TIMEOUT_S = 600;

function validate(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return ['console must be a non-empty list of actions'];
  const errors = [];
  actions.forEach((a, i) => {
    const at = `console action ${i + 1}`;
    if (!a || typeof a !== 'object') return errors.push(`${at}: must be an object`);
    if (!ACTION_KEYS.some((k) => a[k] !== undefined)) errors.push(`${at}: needs expect, send, sleep, or paste`);
    if (a.expect !== undefined) {
      try {
        new RegExp(a.expect, 'i');
      } catch (e) {
        errors.push(`${at}: expect is not a valid regex (${e.message})`);
      }
    }
    if (a.as !== undefined && a.expect === undefined) errors.push(`${at}: "as" needs an expect`);
    if (a.failOn !== undefined) {
      try {
        new RegExp(a.failOn, 'i');
      } catch (e) {
        errors.push(`${at}: failOn is not a valid regex (${e.message})`);
      }
      if (a.paste === undefined) errors.push(`${at}: "failOn" goes with a paste`);
    }
  });
  return errors;
}

// Types `text` into the console one line at a time, waits for the device to
// go quiet, then fails if it printed anything matching `failOn` meanwhile.
// Only line counts are logged, never the lines themselves.
async function paste(a, con, rt) {
  const lines = String(rt.render(a.paste)).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error('paste: nothing to type');
  rt.log(`typing ${lines.length} line(s)`);
  con.expecter.resetTranscript();
  for (const line of lines) {
    con.session.send(`${line}\r`);
    await rt.sleep((a.lineDelay !== undefined ? a.lineDelay : DEFAULT_LINE_DELAY_S) * 1000);
  }
  await con.expecter.quiet((a.settle !== undefined ? a.settle : DEFAULT_SETTLE_S) * 1000, {
    timeoutMs: (a.timeout || DEFAULT_PASTE_TIMEOUT_S) * 1000,
    signal: rt.signal,
  });
  if (a.failOn) {
    const m = new RegExp(a.failOn, 'i').exec(con.expecter.transcript);
    if (m) {
      const text = con.expecter.transcript;
      const from = text.lastIndexOf('\n', m.index) + 1;
      const to = text.indexOf('\n', m.index);
      throw new Error(`the device rejected the pasted configuration: ${text.slice(from, to === -1 ? undefined : to).trim().slice(0, 200)}`);
    }
  }
  rt.log('finished typing; the device reported no errors');
}

async function run(actions, rt) {
  const out = {};
  const con = await rt.console();

  for (const a of actions) {
    if (a.expect !== undefined) {
      const re = new RegExp(rt.render(a.expect), 'i');
      const timeoutMs = (a.timeout || DEFAULT_TIMEOUT_S) * 1000;
      rt.log(`expect /${re.source}/ (up to ${a.timeout || DEFAULT_TIMEOUT_S}s)`);
      try {
        const m = await con.expecter.expect(re, {
          timeoutMs,
          signal: rt.signal,
          onTick: a.nudge ? () => con.session.send('\r') : undefined,
          tickMs: (a.nudge || 10) * 1000,
        });
        if (a.as) out[a.as] = (m[1] !== undefined ? m[1] : m[0]).trim();
        rt.log(`matched${a.as ? ` -> ${a.as} = ${out[a.as]}` : ''}`);
      } catch (err) {
        if (!a.optional || err.message === 'aborted') throw err;
        // The prompt this action reacts to never came, so do not send its
        // answer either -- typing a password at a shell prompt is worse than
        // skipping the step.
        rt.log('no match (optional) -- skipping the rest of this action');
        continue;
      }
    }
    if (a.sleep !== undefined) await rt.sleep(a.sleep * 1000);
    if (a.paste !== undefined) await paste(a, con, rt);
    if (a.send !== undefined) {
      const text = rt.render(String(a.send));
      await rt.sleep(a.delay !== undefined ? a.delay * 1000 : SEND_DELAY_MS);
      rt.log(`send ${JSON.stringify(text)}`);
      con.session.send(a.raw ? text : `${text}\r`);
    }
  }
  return { out };
}

module.exports = { key: 'console', validate, run };
