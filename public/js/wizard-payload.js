// Reads the wizard form into the JSON that POST /api/labs expects, throwing
// an Error with a user-facing message for anything invalid. Exposes
// window.WizardPayload.collect.
(function () {
  const { wizardNameEl, nodesListEl, linksListEl } = window.WizardView.els;

  function collectWizardPayload() {
    const name = wizardNameEl.value.trim();
    if (!name) throw new Error('lab name is required');

    const nodes = {};
    for (const row of nodesListEl.children) {
      const nm = row.querySelector('.wizard-node-name').value.trim();
      const kind = row.querySelector('.wizard-node-kind').value;
      const version = row.querySelector('.wizard-node-version').value; // '' = "(default)" -- omit the field entirely
      if (!nm) throw new Error('every node needs a name');
      if (nodes[nm]) throw new Error(`duplicate node name "${nm}"`);

      const coresStr = row.querySelector('.wizard-node-cores').value.trim();
      const memoryStr = row.querySelector('.wizard-node-memory').value.trim();
      const full = row.querySelector('.wizard-node-full').checked;
      const cores = coresStr ? parseInt(coresStr, 10) : undefined;
      const memory = memoryStr ? parseInt(memoryStr, 10) : undefined;
      if (coresStr && (!Number.isInteger(cores) || cores <= 0)) throw new Error(`node "${nm}": cores must be a positive integer`);
      if (memoryStr && (!Number.isInteger(memory) || memory <= 0)) throw new Error(`node "${nm}": memory (MB) must be a positive integer`);

      nodes[nm] = {
        kind,
        ...(version ? { version } : {}),
        ...(cores ? { cores } : {}),
        ...(memory ? { memory } : {}),
        ...(full ? { full: true } : {}),
      };
    }
    if (Object.keys(nodes).length === 0) throw new Error('add at least one node');

    const links = [];
    for (const block of linksListEl.children) {
      const linkName = block.querySelector('.wizard-link-name').value.trim();
      if (!linkName) throw new Error('every link needs a name');

      // Endpoints apply the same way regardless of external -- an external
      // link with zero endpoints would create the bridge reference but wire
      // nothing to it, which is never actually what's wanted.
      const endpoints = [];
      const seen = new Set();
      for (const erow of block.querySelectorAll('.wizard-endpoints > .wizard-row')) {
        const node = erow.querySelector('.wizard-endpoint-node').value;
        const iface = erow.querySelector('.wizard-endpoint-iface').value;
        if (!node) throw new Error(`link "${linkName}" has an endpoint with no node to pick (add a node first)`);
        const key = `${node}:${iface}`;
        if (seen.has(key)) throw new Error(`link "${linkName}" has the same endpoint (${node}:${iface}) more than once -- pick a different node or interface for one of them`);
        seen.add(key);
        endpoints.push({ node, interface: iface });
      }

      if (block.querySelector('.wizard-link-external').checked) {
        const bridge = block.querySelector('.wizard-link-bridge-select').value;
        if (!bridge) throw new Error(`link "${linkName}" is external but no bridge exists to pick -- create one first`);
        if (endpoints.length < 1) throw new Error(`link "${linkName}" needs at least 1 endpoint (which interface attaches to ${bridge})`);
        links.push({ name: linkName, external: true, bridge, endpoints });
      } else {
        if (endpoints.length < 2) throw new Error(`link "${linkName}" needs at least 2 endpoints`);
        links.push({ name: linkName, endpoints });
      }
    }

    return { name, nodes, links };
  }

  window.WizardPayload = { collect: collectWizardPayload };
})();
