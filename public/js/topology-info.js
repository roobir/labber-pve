// Click-to-inspect info panel for the topology view -- factored out of
// topology-render.js so that file only has to deal with Cytoscape graph
// construction, not also DOM rendering for this panel. Node actions reuse
// the exact same globals the dashboard's own node cards already call
// (window.openConsole/openEmbeddedGui, see dashboard-cards.js) rather than
// duplicating that logic here for a second UI surface.
function createTopologyInfoPanel({ infoEl, infoNameEl, infoMetaEl, infoActionsEl }) {
  // Same fire-and-forget cache as dashboard-cards.js -- gates the "web rp"
  // action the same way, and for the same reason (no gui-proxy.js listener
  // to hit at all without a domain configured).
  let cachedGuiDomain = '';
  window.guiDomain().then((d) => { cachedGuiDomain = d; });

  function hideInfo() {
    infoEl.classList.add('hidden');
  }

  // nodeData is a Cytoscape node's own `data()` -- see topology-render.js's
  // renderGraph() for the exact shape (kind/deployed/running/vmid/status/
  // mgmtIp/mgmtPort, flat on the node itself rather than a nested "live"
  // object, so this file doesn't need to know anything about labStatus's
  // own shape).
  function showInfo(labFile, nodeData) {
    infoEl.classList.remove('hidden');
    infoNameEl.textContent = nodeData.id;
    infoActionsEl.innerHTML = '';

    const bits = [`kind: ${nodeData.kind}`];
    if (nodeData.deployed) {
      bits.push(`vmid: ${nodeData.vmid}`, `status: ${nodeData.status}`);
      if (nodeData.mgmtIp) bits.push(`ip: ${nodeData.mgmtIp}:${Number(nodeData.mgmtPort) || 443}`);
    } else {
      bits.push('not deployed');
    }
    infoMetaEl.textContent = bits.join(' -- ');

    if (!nodeData.running) return;

    const consoleBtn = document.createElement('button');
    consoleBtn.textContent = 'console';
    consoleBtn.addEventListener('click', () => window.openConsole(labFile, nodeData.id));
    infoActionsEl.appendChild(consoleBtn);

    if (nodeData.mgmtIp) {
      const webBtn = document.createElement('button');
      webBtn.textContent = 'web ui';
      webBtn.addEventListener('click', () => window.open(`https://${nodeData.mgmtIp}:${Number(nodeData.mgmtPort) || 443}/`, '_blank'));
      infoActionsEl.appendChild(webBtn);

      if (cachedGuiDomain) {
        const rpBtn = document.createElement('button');
        rpBtn.textContent = 'web rp';
        rpBtn.addEventListener('click', () => window.openEmbeddedGui({ lab: labFile.replace(/\.lab\.yml$/, ''), name: nodeData.id }));
        infoActionsEl.appendChild(rpBtn);
      }
    }
  }

  // A link's hub node (external bridge or 3+-endpoint shared segment, not
  // a real device) -- no vnc/serial/https actions make sense for it, so
  // this is a deliberately separate, simpler panel from showInfo rather
  // than trying to force it through the same "live node" shape.
  function showHubInfo(hubData) {
    infoEl.classList.remove('hidden');
    infoActionsEl.innerHTML = '';
    infoNameEl.textContent = `link: ${hubData.linkName}`;
    infoMetaEl.textContent = hubData.external
      ? `external bridge: ${hubData.bridge}`
      : 'auto-provisioned internal segment';
  }

  function showEdgeInfo(edgeData) {
    infoEl.classList.remove('hidden');
    infoActionsEl.innerHTML = '';
    infoNameEl.textContent = edgeData.isHubSpoke
      ? `${edgeData.source} -- ${edgeData.linkName}`
      : `${edgeData.source} -- ${edgeData.target}`;

    // Hub-spoke edges only carry one interface name (the real device's
    // side -- the other end is just the hub, nothing to label); direct
    // point-to-point edges carry one per side.
    const bits = edgeData.isHubSpoke
      ? [`${edgeData.source}: ${edgeData.label}`]
      : [`${edgeData.source}: ${edgeData.sourceLabel}`, `${edgeData.target}: ${edgeData.targetLabel}`];
    if (edgeData.external) bits.push(`external bridge: ${edgeData.bridge}`);
    infoMetaEl.textContent = bits.join(' -- ');
  }

  return { showInfo, showHubInfo, showEdgeInfo, hideInfo };
}
