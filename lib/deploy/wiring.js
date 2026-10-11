const pve = require('../proxmox-client');
const { parseNicConfig, wiredInterfaces, nicValue } = require('./nics');

// Every NIC the lab wants set, in order: first each link endpoint (wired to
// its link's bridge), then every NIC slot the vendor profile has that no link
// uses. Those still carry the golden template's placeholder `bridge=vmbr0`
// (template-builder.js sets every net0..netN-1 to it), which would put unused
// lab NICs live on the node's real management network -- so they are parked
// link-down instead. A pinned MAC is honored on both (some license checks read
// a MAC whether or not the NIC is wired).
//
// A generator, so the plan is produced lazily: a link naming an unknown node
// fails at that link, after the earlier ones were already applied.
function* wiringPlan(topo, state, nodeHw) {
  const wired = wiredInterfaces(topo);
  const macOf = (node, iface) => ((topo.nodes[node] && topo.nodes[node].mac) || {})[iface] || null;
  for (const link of topo.links || []) {
    const bridge = state.bridges[link.name].iface;
    for (const ep of link.endpoints || []) {
      const nodeState = state.nodes[ep.node];
      if (!nodeState) throw new Error(`Link "${link.name}" references unknown node "${ep.node}"`);
      // Model comes from the node's own vendor profile (a cisco_n9kv needs e1000).
      const model = nodeHw[ep.node].nicModel || 'virtio';
      const mac = macOf(ep.node, ep.interface);
      yield { node: ep.node, vmid: nodeState.vmid, iface: ep.interface, model, mac, bridge, parked: false,
        message: `wiring ${ep.node}:${ep.interface} -> ${bridge}`, value: nicValue(model, mac, bridge) };
    }
  }
  for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
    const hw = nodeHw[nodeName];
    const model = hw.nicModel || 'virtio';
    for (let i = 0; i < hw.nics; i++) {
      const iface = `net${i}`;
      if ((wired[nodeName] || new Set()).has(iface)) continue;
      const mac = macOf(nodeName, iface);
      yield { node: nodeName, vmid: nodeState.vmid, iface, model, mac, bridge: 'vmbr0', parked: true,
        message: `  ${nodeName}:${iface} not wired to any link -- leaving disconnected`, value: nicValue(model, mac, null) };
    }
  }
}

// deploy: write every NIC.
async function applyWiring({ topo, state, nodeHw, onProgress }) {
  for (const nic of wiringPlan(topo, state, nodeHw)) {
    onProgress(nic.message);
    await pve.setVmConfig(nic.vmid, { [nic.iface]: nic.value });
  }
}

// update: write only the NICs whose live config differs, marking those nodes
// for a restart. A node with no live snapshot (brand new) always "differs", so
// it gets its full wiring exactly like a fresh deploy.
async function reconcileWiring({ topo, state, nodeHw, cfgByNode, dirty, onProgress }) {
  for (const nic of wiringPlan(topo, state, nodeHw)) {
    const live = parseNicConfig((cfgByNode[nic.node] || {})[nic.iface]);
    const same = live && live.bridge === nic.bridge && live.linkDown === nic.parked && live.model === nic.model && (!nic.mac || live.mac === nic.mac);
    if (same) continue;
    onProgress(nic.message);
    await pve.setVmConfig(nic.vmid, { [nic.iface]: nic.value });
    dirty.add(nic.node);
  }
}

module.exports = { applyWiring, reconcileWiring };
