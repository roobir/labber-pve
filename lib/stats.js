// Combines lab-file inventory (lab-manager) + live per-node PVE status with
// host resource usage (host-stats) into one snapshot shared by both the
// authenticated /api/stats route (dashboard's own stats bar) and the
// optional unauthenticated /api/public/stats route (public-routes.js) --
// same split old labber's dashboard used, and deliberately the same field
// names (labsTotal/labsActive/vmsRunning/vmsTotal/host.{load,cpu_count,
// memory,disk}) so home-website's telemetry.php (which already knows how to
// read labber's /api/public/stats) needs no changes to point at labber-pve.
function labNameFromFile(filename) {
  return filename.replace(/\.lab\.yml$/, '');
}

async function buildStats({ labManager, hostStats }) {
  const statuses = await labManager.getAllStatuses(); // { [file]: {deployed, nodes} }

  const labs = Object.entries(statuses).map(([file, status]) => {
    const nodes = status.deployed ? Object.values(status.nodes) : [];
    const running = nodes.filter((n) => n.status === 'running').length;
    return {
      name: labNameFromFile(file),
      file,
      active: status.deployed && running > 0,
      runningNodes: running,
      totalNodes: nodes.length,
    };
  });

  return {
    labs,
    labsTotal: labs.length,
    labsActive: labs.filter((l) => l.active).length,
    vmsRunning: labs.reduce((sum, l) => sum + l.runningNodes, 0),
    vmsTotal: labs.reduce((sum, l) => sum + l.totalNodes, 0),
    host: hostStats.getStats(),
  };
}

module.exports = { buildStats };
