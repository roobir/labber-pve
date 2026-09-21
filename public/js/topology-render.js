// Cytoscape graph construction for the topology view. Factored out of
// topology.js (modal chrome/lab-list orchestration) and topology-info.js
// (the click-to-inspect panel) purely for file-size/readability, same split
// as the old libvirt-based labber project this was ported from.
function createTopologyRenderer({ graphEl, infoEl, infoNameEl, infoMetaEl, infoActionsEl }) {
  let cy = null;
  const info = createTopologyInfoPanel({ infoEl, infoNameEl, infoMetaEl, infoActionsEl });

  // A link with exactly 2 endpoints and no external bridge renders as a
  // direct edge between the two real nodes (the common case: a
  // point-to-point auto-provisioned bridge). Anything else -- an external
  // link (reuses a real vmbr, meaningful with just 1 endpoint, e.g. nico-
  // lab's node1--vmbr2 mgmt-only case) or a link with 3+ endpoints (a
  // shared segment, e.g. nico-lab's 3-node "mgmt" link all on vmbr2) --
  // can't be drawn as one point-to-point edge at all, so it gets its own
  // small hub node (labeled with the link's name + bridge, dashed border)
  // with one spoke edge per real endpoint instead.
  function isDirectLink(link) {
    return !link.external && (link.endpoints || []).length === 2;
  }

  function renderGraph(labFile, topo, labStatus) {
    const liveNodes = (labStatus && labStatus.deployed && labStatus.nodes) || {};
    const elements = [];

    for (const [name, nodeSpec] of Object.entries(topo.nodes || {})) {
      const live = liveNodes[name];
      const labelLines = [name, nodeSpec.kind];
      if (live && live.mgmtIp) labelLines.push(live.mgmtIp);
      else if (live) labelLines.push(live.status);
      elements.push({
        data: {
          id: name,
          label: labelLines.join('\n'),
          kind: nodeSpec.kind,
          deployed: !!live,
          running: !!(live && live.status === 'running'),
          vmid: live ? live.vmid : null,
          status: live ? live.status : null,
          mgmtIp: live ? live.mgmtIp : null,
          mgmtPort: live ? live.mgmtPort : null,
        },
      });
    }

    for (const link of topo.links || []) {
      if (isDirectLink(link)) {
        const [a, b] = link.endpoints;
        elements.push({
          data: {
            id: `link-${link.name}`,
            source: a.node,
            target: b.node,
            sourceLabel: a.interface,
            targetLabel: b.interface,
            linkName: link.name,
            external: !!link.external,
            bridge: link.bridge || null,
          },
        });
        continue;
      }

      const hubId = `__hub__${link.name}`;
      elements.push({
        data: {
          id: hubId,
          label: link.external ? `${link.name}\n(${link.bridge})` : link.name,
          isHub: true,
          linkName: link.name,
          external: !!link.external,
          bridge: link.bridge || null,
        },
      });
      for (const ep of link.endpoints || []) {
        elements.push({
          data: {
            id: `${hubId}--${ep.node}`,
            source: ep.node,
            target: hubId,
            label: ep.interface,
            isHubSpoke: true,
            linkName: link.name,
          },
        });
      }
    }

    if (cy) cy.destroy();

    cy = cytoscape({
      container: graphEl,
      elements,
      style: topologyGraphStyle(), // topology-style.js
      layout: { name: 'breadthfirst', directed: false, spacingFactor: 1.4, animate: false },
      boxSelectionEnabled: false,
    });

    cy.on('tap', 'node', (evt) => {
      const d = evt.target.data();
      if (d.isHub) info.showHubInfo(d);
      else info.showInfo(labFile, d);
    });
    cy.on('tap', 'edge', (evt) => info.showEdgeInfo(evt.target.data()));
    cy.on('tap', (evt) => { if (evt.target === cy) info.hideInfo(); });
  }

  function destroy() {
    if (cy) { cy.destroy(); cy = null; }
  }

  function resize() {
    if (cy) cy.resize();
  }

  return { renderGraph, hideInfo: info.hideInfo, destroy, resize };
}
