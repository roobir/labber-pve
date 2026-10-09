const consoleLocks = require('./console-locks');

// Who else is using the dashboard right now. The page heartbeats every ~30s
// (POST /api/presence); anyone seen within ACTIVE_MS counts as active, and
// anyone within RECENT_MS is still listed as recently seen. In-memory only,
// same as sessions: losing it on restart just means the list refills within
// one heartbeat interval.

const ACTIVE_MS = 75 * 1000;
const RECENT_MS = 15 * 60 * 1000;
const lastSeen = new Map(); // username -> epoch ms

function touch(username) {
  lastSeen.set(username, Date.now());
}

function list() {
  const now = Date.now();
  const sessions = consoleLocks.humanSessions();
  const users = [];
  for (const [username, seen] of lastSeen) {
    if (now - seen > RECENT_MS) {
      lastSeen.delete(username);
      continue;
    }
    const consoles = sessions.filter((s) => s.user === username).map((s) => s.key);
    users.push({
      username,
      lastSeen: new Date(seen).toISOString(),
      active: now - seen <= ACTIVE_MS || consoles.length > 0,
      consoles,
    });
  }
  return users.sort((a, b) => Number(b.active) - Number(a.active) || a.username.localeCompare(b.username));
}

module.exports = { touch, list };
