// Expect-style matching over a live console stream: feed() it raw terminal
// output, then expect(regex) to wait for text to appear. Output is
// ANSI-stripped before matching, and a successful match consumes the buffer
// up to the end of the match, so consecutive expects walk forward through
// the conversation instead of re-matching old text.

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[=>]|\x1b\][^\x07]*\x07/g;
const MAX_BUFFER = 64 * 1024;
const TAIL_FOR_ERRORS = 300;
const MAX_TRANSCRIPT = 1024 * 1024;

function stripAnsi(text) {
  return text.replace(ANSI_RE, '').replace(/\r/g, '');
}

class Expecter {
  constructor() {
    this.buffer = '';
    this.pending = null;
    this.transcript = ''; // everything fed since resetTranscript(), unlike `buffer` it is not consumed by expects
    this.lastFeed = Date.now();
  }

  resetTranscript() {
    this.transcript = '';
  }

  feed(raw) {
    const clean = stripAnsi(raw);
    this.lastFeed = Date.now();
    this.transcript = (this.transcript + clean).slice(-MAX_TRANSCRIPT);
    this.buffer += clean;
    if (this.buffer.length > MAX_BUFFER) this.buffer = this.buffer.slice(-MAX_BUFFER);
    this.#check();
  }

  tail() {
    return this.buffer.slice(-TAIL_FOR_ERRORS);
  }

  // Resolves once nothing has arrived for `ms` -- "the device has stopped
  // talking", e.g. after a long pasted configuration has been processed.
  quiet(ms, { timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (signal && signal.aborted) { clearInterval(timer); reject(new Error('aborted')); }
        else if (Date.now() - this.lastFeed >= ms) { clearInterval(timer); resolve(); }
        else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`the device kept printing for over ${Math.round(timeoutMs / 1000)}s`)); }
      }, 100);
    });
  }

  // Waits for `re` to match. `onTick`, if given, runs every `tickMs` while
  // waiting (used to nudge a quiet console with a newline). Rejects on
  // timeout (with the recent output, to make failures diagnosable) or abort.
  expect(re, { timeoutMs, signal, onTick, tickMs = 10000 }) {
    return new Promise((resolve, reject) => {
      if (this.pending) return reject(new Error('another expect is already waiting'));
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(ticker);
        if (signal) signal.removeEventListener('abort', onAbort);
        this.pending = null;
      };
      const onAbort = () => { cleanup(); reject(new Error('aborted')); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for /${re.source}/ -- recent output: ${JSON.stringify(this.tail())}`));
      }, timeoutMs);
      const ticker = onTick ? setInterval(onTick, tickMs) : null;
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending = { re, done: (m) => { cleanup(); resolve(m); } };
      this.#check();
    });
  }

  #check() {
    if (!this.pending) return;
    const m = this.pending.re.exec(this.buffer);
    if (!m) return;
    this.buffer = this.buffer.slice(m.index + m[0].length);
    this.pending.done(m);
  }
}

module.exports = { Expecter, stripAnsi };
