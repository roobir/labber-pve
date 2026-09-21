// Host resource snapshot (CPU load, memory, disk) for the dashboard's stats
// bar and the remote /api/public/stats API -- same role and JSON shape as
// old labber's engine-side host-stats.js/virt/stats.py, but sourced from the
// Proxmox node itself over the API instead of reading /proc directly, since
// this app doesn't run on the hypervisor (see README's "plain HTTPS API
// client" design). Polled on its own timer and cached rather than hit fresh
// on every dashboard/API request, so N browser tabs (or an external poller
// like home-website) don't turn into N x Proxmox API calls every few seconds.
const proxmox = require('./proxmox-client');
const configStore = require('./config-store');

const POLL_INTERVAL_MS = 10000;

const round1 = (n) => Math.round(n * 10) / 10;

let stats = null;
let timer = null;

async function poll() {
  try {
    const node = await proxmox.getNodeStatus();
    const diskStorage = configStore.get().diskStorage;

    let disk;
    if (diskStorage) {
      const s = await proxmox.getStorageStatus(diskStorage);
      disk = {
        path: diskStorage,
        total_gb: round1(s.total / 1024 ** 3),
        used_gb: round1(s.used / 1024 ** 3),
        free_gb: round1(s.avail / 1024 ** 3),
        used_pct: s.total ? round1((s.used / s.total) * 100) : 0,
      };
    } else {
      // No disk storage configured yet -- fall back to the node's own
      // rootfs so the stats bar/API still show *something* meaningful
      // rather than going blank.
      const r = node.rootfs || {};
      disk = {
        path: '(rootfs -- configure a disk storage in Settings)',
        total_gb: round1((r.total || 0) / 1024 ** 3),
        used_gb: round1((r.used || 0) / 1024 ** 3),
        free_gb: round1(((r.total || 0) - (r.used || 0)) / 1024 ** 3),
        used_pct: r.total ? round1((r.used / r.total) * 100) : 0,
      };
    }

    const [load1, load5, load15] = (node.loadavg || ['0', '0', '0']).map(parseFloat);
    const memTotal = node.memory?.total || 0;
    const memUsed = node.memory?.used || 0;

    stats = {
      cpu_count: node.cpuinfo?.cpus || 1,
      cpu_percent: round1((node.cpu || 0) * 100), // not in old labber's shape -- extra, PVE-native figure for our own stats bar
      load: { '1m': load1, '5m': load5, '15m': load15 },
      memory: {
        total_mb: round1(memTotal / 1024 ** 2),
        available_mb: round1((memTotal - memUsed) / 1024 ** 2),
        used_mb: round1(memUsed / 1024 ** 2),
        used_pct: memTotal ? round1((memUsed / memTotal) * 100) : 0,
      },
      disk,
    };
  } catch (err) {
    // Proxmox not configured yet, unreachable, or the configured disk
    // storage was renamed/removed -- leave the last-known-good snapshot in
    // place (or null, before the first successful poll) rather than
    // crashing the poll loop. Same tolerance as every other best-effort
    // poller in this app (network-manager, lab-manager's status reads).
  }
}

function start() {
  poll();
  timer = setInterval(poll, POLL_INTERVAL_MS);
}

function stop() {
  clearInterval(timer);
}

function getStats() {
  return stats;
}

module.exports = { start, stop, getStats };
