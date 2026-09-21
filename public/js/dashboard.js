// Polls /api/status (every lab file + deployed ones' live PVE node status)
// and /api/stats (host CPU/mem/disk) on a 5s interval -- simplest thing
// that works at homelab scale, rather than a push/event stream. Card/panel
// rendering itself lives in dashboard-cards.js (window.DashboardCards) --
// this file owns the polling loop and the stats-bar tiles, and exposes
// `window.Dashboard.refresh` so dashboard-cards.js's power-control buttons
// can force an immediate refresh after an action instead of waiting for
// the next tick.
(function () {
  const grid = document.getElementById('grid');
  const logoutBtn = document.getElementById('logout-btn');
  const statLabs = document.getElementById('stat-labs');
  const statTotal = document.getElementById('stat-total');
  const statBooted = document.getElementById('stat-booted');
  const statCpu = document.getElementById('stat-cpu');
  const statMem = document.getElementById('stat-mem');
  const statDisk = document.getElementById('stat-disk');
  const statDiskLabel = document.getElementById('stat-disk-label');

  // Tracks the last-rendered /api/status payload so refresh() can skip
  // rebuilding the grid entirely when nothing actually changed -- without
  // this, every 5s poll unconditionally did grid.innerHTML = '' and
  // rebuilt every card from scratch, which silently closed any open
  // Maintenance/Access dropdown (or identity panel, or an in-progress
  // mgmt-IP edit) the instant that timer fired, even though the data
  // driving it was identical to what was already on screen.
  let lastLabsJson = null;

  function pctClass(pct) {
    if (pct >= 90) return 'crit';
    if (pct >= 75) return 'warn';
    return '';
  }

  function setPctStat(el, pct, title) {
    el.textContent = `${pct}%`;
    el.className = `stat-value ${pctClass(pct)}`;
    if (title) el.title = title;
  }

  // Proxmox node CPU/mem/disk -- separate poll from /api/status below since
  // it's a different endpoint (/api/stats, shared with /api/public/stats),
  // but folded into the same 5s refresh() tick rather than its own timer.
  async function refreshHostStats() {
    let data;
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) return;
      data = await res.json();
    } catch (err) {
      return; // leave last-known tiles in place
    }

    const host = data.host;
    if (!host) {
      statCpu.textContent = '-';
      statMem.textContent = '-';
      statDisk.textContent = '-';
      return;
    }

    setPctStat(statCpu, host.cpu_percent, `load ${host.load['1m']} / ${host.load['5m']} / ${host.load['15m']}`);
    setPctStat(statMem, host.memory.used_pct, `${(host.memory.used_mb / 1024).toFixed(1)} / ${(host.memory.total_mb / 1024).toFixed(1)} GB`);
    setPctStat(statDisk, host.disk.used_pct, `${host.disk.used_gb} / ${host.disk.total_gb} GB -- ${host.disk.path}`);
    statDiskLabel.textContent = 'disk storage';
  }

  async function refresh() {
    let data;
    try {
      const res = await fetch('/api/status');
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      data = await res.json();
    } catch (err) {
      return;
    }

    // Bail out before touching the DOM at all if this poll's data is
    // byte-for-byte identical to the last one actually rendered -- the
    // overwhelmingly common case for a lab that isn't mid-deploy/destroy,
    // and exactly the case where tearing down open dropdowns/panels for
    // no reason was most jarring.
    const labsJson = JSON.stringify(data.labs || {});
    if (labsJson === lastLabsJson) return;
    lastLabsJson = labsJson;

    const allEntries = Object.entries(data.labs || {});
    const deployedEntries = allEntries.filter(([, l]) => l.deployed);
    const notDeployedEntries = allEntries.filter(([, l]) => !l.deployed);

    statLabs.textContent = deployedEntries.length;
    statTotal.textContent = data.totalNodes ?? 0;
    statBooted.textContent = data.bootedNodes ?? 0;

    grid.innerHTML = '';

    if (allEntries.length === 0) {
      grid.innerHTML = '<div class="empty-hint">No lab files found. Open "labs" to create one.</div>';
      return;
    }

    // Render groups directly into the page body (grid itself becomes a
    // simple container here since each group carries its own sub-grid).
    grid.style.display = 'block';
    grid.style.padding = '0';

    if (deployedEntries.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'No labs deployed. Open "labs" to deploy one.';
      grid.appendChild(hint);
    }
    for (const [labFile, labStatus] of deployedEntries) {
      grid.appendChild(window.DashboardCards.labGroup(labFile, labStatus));
    }
    for (const [labFile] of notDeployedEntries) {
      grid.appendChild(window.DashboardCards.notDeployedRow(labFile));
    }
  }

  logoutBtn.addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  refresh();
  refreshHostStats();
  setInterval(refresh, 5000);
  setInterval(refreshHostStats, 5000);

  window.Dashboard = { refresh };
})();
