// While a bootstrap runbook sits in a long step (an appliance still booting,
// services restarting after provisioning), the lab log would otherwise show
// nothing for minutes. This prints "still running <step> (3m)" now and then,
// so a quiet log means "waiting", not "stuck" -- and it is also traffic on the
// log's connection. Interval: BOOTSTRAP_HEARTBEAT_MS (default one minute).

const INTERVAL_MS = Number(process.env.BOOTSTRAP_HEARTBEAT_MS) || 60 * 1000;

function elapsed(ms) {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

function startHeartbeat(label, onProgress) {
  let current = null; // { name, since } of the step now running
  const timer = setInterval(() => {
    if (current && Date.now() - current.since >= INTERVAL_MS) {
      onProgress(`${label}: still running "${current.name}" (${elapsed(Date.now() - current.since)})`);
    }
  }, INTERVAL_MS);
  timer.unref();
  return {
    stepEvent(e) {
      if (e.type !== 'step') return;
      current = e.state === 'running' ? { name: e.name, since: Date.now() } : null;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { startHeartbeat };
