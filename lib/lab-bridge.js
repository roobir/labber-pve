const labManager = require('./lab-manager');

// Same shape as clab-dashboard's lab-bridge.js and the protocol its
// public/js/labs.js already speaks (started/data/done/error) -- but there's
// no real subprocess to stream here, so deploy()/destroy()'s onProgress
// callback stands in for "stdout".
function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function handleConnection(ws) {
  let running = false;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type !== 'run') return;

    if (running) {
      safeSend(ws, { type: 'error', message: 'A command is already running on this connection' });
      return;
    }
    if (msg.action !== 'deploy' && msg.action !== 'destroy' && msg.action !== 'update') {
      safeSend(ws, { type: 'error', message: `Unknown action: ${msg.action}` });
      return;
    }

    running = true;
    safeSend(ws, { type: 'started' });

    const onProgress = (line) => safeSend(ws, { type: 'data', data: `${line}\n` });

    try {
      if (msg.action === 'deploy') {
        await labManager.deploy(msg.lab, onProgress);
      } else if (msg.action === 'update') {
        await labManager.update(msg.lab, onProgress);
      } else {
        await labManager.destroy(msg.lab, onProgress);
      }
      safeSend(ws, { type: 'done', exitCode: 0 });
    } catch (err) {
      // err.message already reached the terminal pane via onProgress's own
      // "ERROR: ..." line (both deploy() and destroy() emit one before
      // rethrowing) -- passed through here too so the status line above the
      // terminal shows it as well, instead of a bare "exit 1" with no
      // explanation of what actually failed.
      safeSend(ws, { type: 'done', exitCode: 1, error: err.message });
    } finally {
      running = false;
    }
  });
}

module.exports = { handleConnection };
