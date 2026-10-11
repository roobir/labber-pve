const labManager = require('./lab-manager');

// Live output of lab operations (deploy / destroy / update / bootstrap) over
// a websocket. Messages to the browser: started, data, done, error, replay,
// none. From the browser: run {lab, action}, attach {lab}.
//
// An operation belongs to its LAB, not to the connection that started it. The
// output so far is kept in memory (the latest operation per lab), so:
//   - a browser whose connection dropped (proxy idle timeout, laptop sleep,
//     a network blip) reconnects with `attach` and gets everything it missed
//     replayed, then keeps following live -- the operation itself never
//     depended on the page staying connected;
//   - a second person (or tab) running something on a lab that is already
//     busy is shown the running operation's output instead of starting a
//     clash.

const ACTIONS = ['deploy', 'destroy', 'update', 'bootstrap'];
const MAX_LINES = 5000;
const operations = new Map(); // lab -> { lab, action, user, lines, running, result, subscribers }

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(op, payload) {
  for (const ws of op.subscribers) safeSend(ws, payload);
}

function invoke(op) {
  const { lab, user } = op;
  const onProgress = (line) => {
    op.lines.push(line);
    if (op.lines.length > MAX_LINES) op.lines.shift();
    broadcast(op, { type: 'data', data: `${line}\n` });
  };
  switch (op.action) {
    case 'deploy': return labManager.deploy(lab, onProgress, { user });
    case 'bootstrap': return labManager.runBootstrap(lab, onProgress, { user });
    case 'update': return labManager.update(lab, onProgress);
    default: return labManager.destroy(lab, onProgress);
  }
}

function startOperation(lab, action, user) {
  const op = { lab, action, user, lines: [], running: true, result: null, subscribers: new Set() };
  operations.set(lab, op);
  // Wrapped so even a synchronous throw from the action ends up as a normal "done" with an error.
  Promise.resolve()
    .then(() => invoke(op))
    .then(() => ({ exitCode: 0 }))
    // err.message already reached the terminal via onProgress's own "ERROR: ..." line for
    // deploy/destroy, but is passed along too so the status line shows it.
    .catch((err) => ({ exitCode: 1, error: err.message }))
    .then((result) => {
      op.running = false;
      labManager.invalidateVmStatuses();
      op.result = result;
      broadcast(op, { type: 'done', action: op.action, ...result });
    });
  return op;
}

function handleConnection(ws, req) {
  const user = (req && req.session && req.session.username) || 'unknown';
  const following = new Set();

  function follow(op, { replay }) {
    op.subscribers.add(ws);
    following.add(op);
    if (!replay) return;
    safeSend(ws, {
      type: 'replay',
      action: op.action,
      user: op.user,
      running: op.running,
      data: op.lines.map((line) => `${line}\n`).join(''),
    });
    if (!op.running && op.result) safeSend(ws, { type: 'done', action: op.action, ...op.result });
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'attach') {
      const op = operations.get(msg.lab);
      if (op) follow(op, { replay: true });
      else safeSend(ws, { type: 'none' });
      return;
    }
    if (msg.type !== 'run') return;

    if (!ACTIONS.includes(msg.action)) {
      safeSend(ws, { type: 'error', message: `Unknown action: ${msg.action}` });
      return;
    }
    const existing = operations.get(msg.lab);
    if (existing && existing.running) {
      safeSend(ws, { type: 'error', message: `"${msg.lab}" already has a ${existing.action} running (started by ${existing.user}) -- showing its output` });
      follow(existing, { replay: true });
      return;
    }

    const op = startOperation(msg.lab, msg.action, user);
    follow(op, { replay: false });
    safeSend(ws, { type: 'started' });
  });

  ws.on('close', () => {
    for (const op of following) op.subscribers.delete(ws);
  });
}

module.exports = { handleConnection };
