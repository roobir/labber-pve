const pve = require('../proxmox-client');
const vendors = require('../vendor-profiles');
const { parseTopology, readState } = require('../lab-files');
const { cloneNode } = require('./node-ops');
const { provisionBridges } = require('./bridges');
const { applyWiring } = require('./wiring');

const describeKind = (spec) => `${spec.kind}${spec.version ? ` v${spec.version}` : ''}`;

// onProgress(line) is optional -- lab-bridge.js passes one to stream
// human-readable step-by-step output to the dashboard's terminal pane. There's
// no real CLI subprocess to stream from, so these lines are synthesized at
// each real step instead.
async function deploy(name, onProgress = () => {}) {
  const labName = name.replace(/\.lab\.yml$/, '');
  const topo = parseTopology(name);
  if (readState(name)) throw new Error(`"${name}" already has a deployed state -- destroy it first`);

  const state = { nodes: {}, bridges: {} };
  const nodeHw = {}; // nodeName -> profile.hw, for this call only: wiring needs every NIC slot a node has

  try {
    // 1. Clone every node from its vendor's golden template.
    for (const [nodeName, nodeSpec] of Object.entries(topo.nodes)) {
      const profile = vendors.requireProfile(nodeSpec.kind, nodeSpec.version);
      nodeHw[nodeName] = profile.hw;
      onProgress(`cloning ${nodeName} (${describeKind(nodeSpec)}) from template ${profile.templateId}...`);
      await cloneNode({
        name, labName, nodeName, nodeSpec, profile, state,
        hooks: {
          cloned(vmid) {
            onProgress(`  -> ${nodeName} cloned as vmid ${vmid}`);
            if (nodeSpec.mgmtIp) onProgress(`  -> ${nodeName} mgmt IP restored: ${nodeSpec.mgmtIp}`);
          },
        },
      });
      if (nodeSpec.cores || nodeSpec.memory) {
        onProgress(`  -> ${nodeName} overridden: ${nodeSpec.cores ? `${nodeSpec.cores} cores` : ''}${nodeSpec.cores && nodeSpec.memory ? ', ' : ''}${nodeSpec.memory ? `${nodeSpec.memory}MB memory` : ''}`);
      }
      if (nodeSpec.uuid) onProgress(`  -> ${nodeName} pinned uuid ${nodeSpec.uuid}`);
    }

    // 2. Provision every link's bridge (or reuse an external one), 3. wire each NIC.
    await provisionBridges({ name, labName, topo, state, onProgress });
    await applyWiring({ topo, state, nodeHw, onProgress });

    // 4. Boot everything.
    for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
      onProgress(`starting ${nodeName} (vmid ${nodeState.vmid})...`);
      await pve.startVm(nodeState.vmid);
    }

    onProgress(`lab "${labName}" deployed: ${Object.keys(state.nodes).length} node(s)`);
    return state;
  } catch (err) {
    onProgress(`ERROR: ${err.message}`);
    throw err;
  }
}

module.exports = { deploy, describeKind };
