const runs = require('./runbooks/runs');

// Websocket for watching a run live. Browser -> server: attach {runId},
// abort {runId}, detach. Server -> browser: every run event (log, step,
// console, done), replayed from the start on attach so a late or restored
// window sees the whole run.

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function handleConnection(ws, req) {
  const user = (req && req.session && req.session.username) || 'unknown';
  let unsubscribe = null;

  const detach = () => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'attach') {
      detach();
      unsubscribe = runs.subscribe(msg.runId, (event) => safeSend(ws, event));
      if (!unsubscribe) safeSend(ws, { type: 'error', message: 'unknown run (the server may have restarted)' });
    } else if (msg.type === 'abort') {
      try {
        runs.abort(msg.runId, `aborted by ${user}`);
      } catch (err) {
        safeSend(ws, { type: 'error', message: err.message });
      }
    } else if (msg.type === 'detach') {
      detach();
    }
  });

  ws.on('close', detach);
}

module.exports = { handleConnection };
