// Keeps websocket connections alive through idle timeouts.
//
// A proxy in front of the app (nginx's proxy_read_timeout, HAProxy's tunnel
// timeout, a cloud load balancer, ...) drops a websocket that has carried no
// bytes for about a minute. A deploy whose runbooks sit in a long quiet wait
// (an appliance still booting) is exactly that, so the proxy cut the live log
// while the work carried on, and the page never noticed. A protocol-level ping
// every few seconds is traffic in both directions, which resets those timers.
// Browsers answer pings on their own, so the page needs no code for it; a
// client that stops answering (closed laptop, dead network) is dropped after
// a few missed rounds instead of lingering as a dead subscriber. Several, not
// one, so a slow link or a middlebox that is slow to relay a pong never costs a
// live console its connection.

const MAX_MISSED = 3;

function attachHeartbeat(wss, intervalMs = 25 * 1000) {
  wss.on('connection', (ws) => {
    ws.missed = 0;
    const alive = () => { ws.missed = 0; };
    ws.on('pong', alive);
    ws.on('message', alive); // any traffic proves the client is there, even if its pong is queued behind a big frame
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.missed >= MAX_MISSED) {
        ws.terminate();
        continue;
      }
      ws.missed += 1;
      try {
        ws.ping();
      } catch (e) {
        // socket closing underneath us -- the next round drops it
      }
    }
  }, intervalMs);
  timer.unref();
  wss.on('close', () => clearInterval(timer));
  return () => clearInterval(timer);
}

module.exports = { attachHeartbeat };
