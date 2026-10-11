// Follows a lab operation's live output (deploy / destroy / update / bootstrap)
// over /ws/lab, and survives the connection dropping.
//
// The operation runs on the server whether or not this page stays connected, so
// a dropped connection (a proxy's idle timeout, a laptop sleeping, a network
// blip) must not look like the end of the log. When the socket closes before
// the operation has finished, this says so and reconnects, asking the server
// to `attach` to the lab's operation: it replays everything missed so far and
// then carries on live.
//
//   const stream = LabsStream.open({ lab, action, write, clear, status, done, quietIfNone });
//   stream.close();   // stop following (does not stop the operation)
//
// `action` starts a new operation; omit it to only follow one already running.
// Callbacks: write(text), clear(), status(text, isError), done(msg, live) -- `live`
// is true when the operation was seen running (started here, or still running
// when we attached), false when only a finished one was replayed; msg is null
// when there is nothing to report (no record on the server, or gave up).
window.LabsStream = (function () {
  const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
  const MAX_RETRIES = 12;

  function open({ lab, action, write, clear, status, done, quietIfNone, WebSocketImpl }) {
    const Socket = WebSocketImpl || window.WebSocket;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws/lab`;
    let ws = null;
    let finished = false;
    let stopped = false;
    let retries = 0;
    let timer = null;
    let live = !!action;

    function finish(msg) {
      finished = true;
      if (ws) { ws.close(); ws = null; }
      done(msg, live);
    }

    function handle(msg) {
      if (msg.type === 'data') {
        write(msg.data);
      } else if (msg.type === 'replay') {
        live = msg.running;
        clear();
        write(msg.data);
        if (msg.running) status(`following the ${msg.action} that ${msg.user} started...`);
      } else if (msg.type === 'error') {
        status(msg.message, true);
      } else if (msg.type === 'none') {
        finished = true;
        if (!quietIfNone) status('the server has no record of this operation (it may have restarted) -- check the dashboard and the Runs tab', true);
        done(null, false);
      } else if (msg.type === 'done') {
        finish(msg);
      }
    }

    function scheduleReconnect() {
      retries += 1;
      if (retries > MAX_RETRIES) {
        finished = true;
        status('lost the connection and could not get it back -- the operation may still be running; check the dashboard and the Runs tab', true);
        done(null, false);
        return;
      }
      const delay = RETRY_DELAYS_MS[Math.min(retries - 1, RETRY_DELAYS_MS.length - 1)];
      status(`connection lost -- the operation keeps running on the server; reconnecting in ${Math.round(delay / 1000)}s (try ${retries})...`, true);
      timer = setTimeout(() => connect(false), delay);
    }

    function connect(first) {
      ws = new Socket(url);
      ws.addEventListener('open', () => {
        retries = 0;
        if (!first) status('reconnected -- catching up...');
        ws.send(JSON.stringify(first && action ? { type: 'run', action, lab } : { type: 'attach', lab }));
      });
      ws.addEventListener('message', (ev) => handle(JSON.parse(ev.data)));
      ws.addEventListener('close', () => {
        ws = null;
        if (!finished && !stopped) scheduleReconnect();
      });
    }

    connect(true);
    return {
      close() {
        stopped = true;
        clearTimeout(timer);
        if (ws) ws.close();
      },
    };
  }

  return { open };
})();
