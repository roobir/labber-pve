const pve = require('./proxmox-client');
const net = require('./network-manager');
const vendors = require('./vendor-profiles');
const configStore = require('./config-store');
const identity = require('./node-identity');
const { toDnsSafeName } = require('./dns-safe-name');
const { parseTopology, readState, writeState, clearState } = require('./lab-files');
const { withLock, isLocked } = require('./async-lock');

// Shared across every lab -- VMIDs are a single global Proxmox namespace,
// not per-lab, so two different labs' deploys can't be allowed to compute
// "free" VMIDs concurrently either (see allocateVmid()'s own comment).
const VMID_LOCK_KEY = 'vmid-alloc';

const VMID_RANGE_START = 9000; // stays clear of manually-assigned low VMIDs
const VMID_RANGE_END = 9999;

// --- VMID allocation ---------------------------------------------------------
// Same deterministic-hash-then-linear-probe approach as network-manager's
// bridge numbers, just against real VM/CT IDs instead of interface names.
function hashSeed(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

async function allocateVmid(seed) {
  // PVE's VMID namespace is shared between QEMU VMs and LXC containers --
  // listVms() alone missed containers, so a "free" pick here could collide
  // with an existing CT ("unable to create VM <n> -- CT <n> already
  // exists"). See lib/proxmox-vm.js's listContainers() for the full story.
  //
  // This function only *picks* an id -- it doesn't reserve it (nothing is
  // actually taken until the caller's cloneVm() completes). Every call site
  // wraps the pick-then-clone pair together in the VMID_LOCK_KEY lock below
  // for exactly that reason: without it, two concurrent deploys/updates
  // (different labs, or the same lab from two tabs) could both list the
  // same "taken" set and pick the same free id before either has actually
  // created anything with it.
  const [vms, cts] = await Promise.all([pve.listVms(), pve.listContainers()]);
  const taken = new Set([...vms, ...cts].map((v) => v.vmid));
  let n = VMID_RANGE_START + (hashSeed(seed) % (VMID_RANGE_END - VMID_RANGE_START));

  for (let attempts = 0; attempts < VMID_RANGE_END - VMID_RANGE_START; attempts++) {
    if (!taken.has(n)) return n;
    n = n + 1 >= VMID_RANGE_END ? VMID_RANGE_START : n + 1;
  }
  throw new Error(`No free VMIDs available (${VMID_RANGE_START}-${VMID_RANGE_END} exhausted)`);
}

// A netN value's shape is `<model>[=<mac>][,bridge=X][,firewall=0][,link_down=1]`
// -- unlike node-identity.js's parseMac/buildNicValue (which only ever touch
// the model=mac portion, preserving everything else verbatim for the anchor
// feature), update()'s wiring diff needs to compare bridge/link_down too, so
// this pulls all of them out for a field-by-field comparison rather than a
// fragile whole-string compare (param order isn't guaranteed to round-trip
// identically through Proxmox).
function parseNicConfig(netValue) {
  if (!netValue) return null;
  const parts = netValue.split(',');
  const [model, mac] = parts[0].split('=');
  const rest = Object.fromEntries(parts.slice(1).map((p) => p.split('=')));
  return { model, mac: mac || null, bridge: rest.bridge || null, linkDown: rest.link_down === '1' };
}

// --- Deploy -------------------------------------------------------------------
// onProgress(line) is optional -- lab-bridge.js passes one to stream
// human-readable step-by-step output to the dashboard's terminal pane, the
// same UX as containerlab's own deploy/destroy output in clab-dashboard.
// There's no real CLI subprocess here to stream from (unlike containerlab),
// so these lines are synthesized at each real step instead.
async function deploy(name, onProgress = () => {}) {
  const labName = name.replace(/\.lab\.yml$/, '');
  const topo = parseTopology(name);

  if (readState(name)) {
    throw new Error(`"${name}" already has a deployed state -- destroy it first`);
  }

  const state = { nodes: {}, bridges: {} };
  const nodeHw = {}; // nodeName -> profile.hw, kept only for this deploy() call -- used below to
  // find every NIC slot a node has (not just the ones a link wires up)

  try {
    // 1. Clone every node from its vendor's golden template.
    for (const [nodeName, nodeSpec] of Object.entries(topo.nodes)) {
      const profile = vendors.requireProfile(nodeSpec.kind, nodeSpec.version);
      nodeHw[nodeName] = profile.hw;
      onProgress(`cloning ${nodeName} (${nodeSpec.kind}${nodeSpec.version ? ` v${nodeSpec.version}` : ''}) from template ${profile.templateId}...`);
      const diskStorage = configStore.get().diskStorage;
      const full = !!nodeSpec.full;
      const vmid = await withLock(VMID_LOCK_KEY, async () => {
        const id = await allocateVmid(`${labName}:${nodeName}`);
        await pve.cloneVm({
          templateId: profile.templateId,
          newId: id,
          // Same DNS-hostname validation template-builder.js hit -- labName
          // is already restricted to [a-zA-Z0-9_-] by createLab(), but
          // nodeName is a free-form YAML map key (wizard text input or
          // hand-edited file) and could contain underscores/spaces/anything.
          name: toDnsSafeName(`labber-pve-${labName}-${nodeName}`),
          full,
          // Confirmed against a real PVE node: `storage` is flatly rejected for
          // linked clones ("parameter 'storage' not allowed for linked clones")
          // -- a linked clone's overlay always lives alongside the template's
          // own disk, no way to redirect it. Only full clones can target a
          // different storage.
          ...(full && diskStorage ? { targetStorage: diskStorage } : {}),
        });
        return id;
      });
      state.nodes[nodeName] = { vmid, kind: nodeSpec.kind, version: nodeSpec.version };
      // A previously-saved mgmt IP (lib/lab-state.js's setNodeMgmtIp
      // persists it here as well as into runtime state) carries straight
      // into this fresh deploy -- most vendor appliance images have no
      // guest agent to auto-detect an IP from, and a static/DHCP-reserved
      // address is common enough that re-typing it after every destroy+
      // redeploy is real, avoidable friction, same reasoning as the
      // uuid/mac pinning just below.
      if (nodeSpec.mgmtIp) {
        state.nodes[nodeName].mgmtIp = nodeSpec.mgmtIp;
        state.nodes[nodeName].mgmtPort = nodeSpec.mgmtPort || 443;
      }
      writeState(name, state); // persist progressively so a mid-failure destroy has something real to clean up
      onProgress(`  -> ${nodeName} cloned as vmid ${vmid}`);
      if (nodeSpec.mgmtIp) onProgress(`  -> ${nodeName} mgmt IP restored: ${nodeSpec.mgmtIp}`);

      // Per-node cores/memory override -- a clone otherwise inherits the
      // vendor template's fixed hw profile verbatim, which means every node
      // of the same kind is stuck at identical size unless you edit the
      // shared golden template itself (affecting every future clone, not
      // just this one lab). Applied as a separate config call right after
      // clone rather than folded into cloneVm() -- PVE's clone endpoint has
      // no cores/memory params of its own, only the source template's.
      //
      // `agent: 1` is set unconditionally alongside it -- opportunistic, not
      // a guarantee: it only lets PVE *attempt* the guest-agent
      // network-get-interfaces call the dashboard's IP-detect button uses
      // (see getAgentInterfaces()), which still depends on qemu-guest-agent
      // actually running inside the guest. Harmless to set even when it
      // isn't -- destroy() already always uses the hard 'stop' API (not
      // 'shutdown'), which never waits on the agent regardless of this flag.
      const hwOverride = { agent: '1' };
      if (nodeSpec.cores) hwOverride.cores = nodeSpec.cores;
      if (nodeSpec.memory) hwOverride.memory = nodeSpec.memory;
      // Pinning the SMBIOS UUID here (right after clone, same call as the
      // cores/memory override) is what makes a UUID-keyed vendor license
      // survive a destroy+redeploy -- left unset, Proxmox generates a fresh
      // one on every clone. See lib/node-identity.js.
      if (nodeSpec.uuid) hwOverride.smbios1 = `uuid=${nodeSpec.uuid}`;
      await pve.setVmConfig(vmid, hwOverride);
      if (nodeSpec.cores || nodeSpec.memory) {
        onProgress(`  -> ${nodeName} overridden: ${nodeSpec.cores ? `${nodeSpec.cores} cores` : ''}${nodeSpec.cores && nodeSpec.memory ? ', ' : ''}${nodeSpec.memory ? `${nodeSpec.memory}MB memory` : ''}`);
      }
      if (nodeSpec.uuid) onProgress(`  -> ${nodeName} pinned uuid ${nodeSpec.uuid}`);
    }

    // 2. Provision every link's bridge (or reuse an external one).
    for (const link of topo.links || []) {
      onProgress(link.external ? `link "${link.name}": reusing external bridge ${link.bridge}` : `link "${link.name}": provisioning bridge...`);
      const { iface, created } = await net.ensureLinkBridge(labName, link);
      state.bridges[link.name] = { iface, created };
      writeState(name, state);
      onProgress(`  -> ${iface}`);
    }
    if (Object.values(state.bridges).some((b) => b.created)) {
      onProgress('applying network changes...');
      await net.applyPendingChanges();
    }

    // 3. Wire each node's interfaces to their link's bridge.
    for (const link of topo.links || []) {
      const iface = state.bridges[link.name].iface;
      for (const ep of link.endpoints || []) {
        const nodeState = state.nodes[ep.node];
        if (!nodeState) throw new Error(`Link "${link.name}" references unknown node "${ep.node}"`);
        // Model comes from the node's own vendor profile (nodeHw), not a
        // hardcoded 'virtio' as before -- that mismatched step 3b just below
        // (which already used hw.nicModel), silently giving a kind like
        // cisco_n9kv (nicModel: e1000, required by that image) a plain
        // virtio NIC on every *wired* interface while its unwired ones
        // correctly got e1000. mac (optional, see lib/node-identity.js)
        // pins the interface's MAC across redeploys -- left undefined, PVE
        // auto-assigns one from its own bc:24:11 OUI as before.
        const mac = topo.nodes[ep.node].mac && topo.nodes[ep.node].mac[ep.interface];
        onProgress(`wiring ${ep.node}:${ep.interface} -> ${iface}`);
        await pve.setVmConfig(nodeState.vmid, {
          [ep.interface]: `${identity.nicPrefix(nodeHw[ep.node].nicModel || 'virtio', mac)},bridge=${iface},firewall=0`,
        });
      }
    }

    // 3b. Any NIC slot a node has (per its vendor profile's `nics` count)
    // that no link's endpoint referenced still has the golden template's
    // placeholder wiring -- template-builder.js sets every net0..netN-1 to
    // `bridge=vmbr0` at template-build time as a value that must be
    // *something*, not a deliberate choice for this lab, and a plain clone
    // copies it verbatim. Left alone, that silently puts unused lab NICs
    // live on vmbr0 (typically the node's real management/DHCP network).
    // Explicitly mark those interfaces link-down instead, so nothing this
    // lab didn't ask for ends up bridged onto the physical network.
    const wiredByNode = {};
    for (const link of topo.links || []) {
      for (const ep of link.endpoints || []) {
        (wiredByNode[ep.node] ||= new Set()).add(ep.interface);
      }
    }
    for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
      const hw = nodeHw[nodeName];
      const wired = wiredByNode[nodeName] || new Set();
      const macMap = topo.nodes[nodeName].mac || {};
      for (let i = 0; i < hw.nics; i++) {
        const iface = `net${i}`;
        if (wired.has(iface)) continue;
        onProgress(`  ${nodeName}:${iface} not wired to any link -- leaving disconnected`);
        // A pinned MAC is honored even on a disconnected NIC -- some license
        // checks read the interface's MAC regardless of whether it's
        // actually wired to anything.
        await pve.setVmConfig(nodeState.vmid, {
          [iface]: `${identity.nicPrefix(hw.nicModel || 'virtio', macMap[iface])},bridge=vmbr0,firewall=0,link_down=1`,
        });
      }
    }

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

// --- Destroy ------------------------------------------------------------------
// Wrapped in the same try/catch + onProgress(ERROR) pattern as deploy() --
// previously any failure here (a stuck VM, a Proxmox API error tearing down
// a bridge) propagated with no ERROR line ever written to the terminal
// pane, and lab-bridge.js's own catch discards the Error object entirely,
// so the user saw nothing beyond a bare "exit 1".
async function destroy(name, onProgress = () => {}) {
  const state = readState(name);
  if (!state) throw new Error(`"${name}" has no deployed state to destroy`);

  try {
    for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
      onProgress(`stopping ${nodeName} (vmid ${nodeState.vmid})...`);
      try {
        await pve.stopVm(nodeState.vmid, { graceful: false });
      } catch (e) {
        // already stopped/gone -- fine, still attempt delete below
      }
      onProgress(`deleting ${nodeName}...`);
      try {
        await pve.deleteVm(nodeState.vmid);
      } catch (e) {
        // VM config already gone (e.g. deleted by hand in the Proxmox UI,
        // or a previous destroy got partway through before failing) --
        // nothing left to delete, so don't let this abort the rest of the
        // teardown (bridges + clearState below) the way any other API
        // error still should.
        if (!/does not exist/i.test(e.message)) throw e;
        onProgress(`${nodeName} (vmid ${nodeState.vmid}) already gone, skipping`);
      }
    }

    for (const [linkName, bridge] of Object.entries(state.bridges)) {
      if (bridge.created) {
        onProgress(`removing bridge ${bridge.iface} (link "${linkName}")...`);
        await net.teardownBridge(bridge.iface);
      }
    }
    if (Object.values(state.bridges).some((b) => b.created)) {
      onProgress('applying network changes...');
      await net.applyPendingChanges();
    }

    clearState(name);
    onProgress(`lab "${name}" destroyed`);
  } catch (err) {
    onProgress(`ERROR: ${err.message}`);
    throw err;
  }
}

// --- Update -------------------------------------------------------------------
// Patches an already-deployed lab's VMs to match the current saved YAML,
// without re-cloning -- the whole point being to preserve each node's
// in-guest state (any config made after boot) instead of throwing it away
// on every hw/uuid/mac/wiring tweak the way a destroy()+deploy() cycle
// does. Live Proxmox config is the diff source of truth (same idiom
// node-identity.js's parseIdentity/applyIdentity already established for
// the anchor feature) rather than a second "last applied spec" persisted
// in state.json -- only fields that actually differ get patched, and only
// nodes that actually changed get restarted (stop+start -- unavoidable,
// since UUID/hw/wiring are all read by the guest at boot regardless of
// vendor, but far cheaper than deploy()'s re-clone + first-boot-init for
// every node whether it changed or not).
async function update(name, onProgress = () => {}) {
  const labName = name.replace(/\.lab\.yml$/, '');
  const topo = parseTopology(name);
  const state = readState(name);
  if (!state) throw new Error(`"${name}" is not deployed -- use deploy instead`);

  const dirty = new Set(); // node names that need a stop+start to apply changes
  const addedNodeNames = new Set(); // subset of `dirty` that are brand new (start only, nothing to stop)
  const nodeHw = {};
  const cfgByNode = {};
  let addedCount = 0;
  let removedCount = 0;

  try {
    // 1. Add nodes present in the new topology but not yet deployed -- same
    // clone+hw-override+uuid-pin sequence as deploy() step 1 (duplicated
    // rather than shared: deploy() is already tested/working and this is
    // the only other call site).
    for (const [nodeName, nodeSpec] of Object.entries(topo.nodes)) {
      if (state.nodes[nodeName]) continue;
      const profile = vendors.requireProfile(nodeSpec.kind, nodeSpec.version);
      nodeHw[nodeName] = profile.hw;
      onProgress(`adding new node ${nodeName} (${nodeSpec.kind}${nodeSpec.version ? ` v${nodeSpec.version}` : ''})...`);
      const diskStorage = configStore.get().diskStorage;
      const full = !!nodeSpec.full;
      const vmid = await withLock(VMID_LOCK_KEY, async () => {
        const id = await allocateVmid(`${labName}:${nodeName}`);
        await pve.cloneVm({
          templateId: profile.templateId,
          newId: id,
          name: toDnsSafeName(`labber-pve-${labName}-${nodeName}`),
          full,
          ...(full && diskStorage ? { targetStorage: diskStorage } : {}),
        });
        return id;
      });
      state.nodes[nodeName] = { vmid, kind: nodeSpec.kind, version: nodeSpec.version };
      if (nodeSpec.mgmtIp) {
        state.nodes[nodeName].mgmtIp = nodeSpec.mgmtIp;
        state.nodes[nodeName].mgmtPort = nodeSpec.mgmtPort || 443;
      }
      writeState(name, state);
      onProgress(`  -> ${nodeName} cloned as vmid ${vmid}`);

      const hwOverride = { agent: '1' };
      if (nodeSpec.cores) hwOverride.cores = nodeSpec.cores;
      if (nodeSpec.memory) hwOverride.memory = nodeSpec.memory;
      if (nodeSpec.uuid) hwOverride.smbios1 = `uuid=${nodeSpec.uuid}`;
      await pve.setVmConfig(vmid, hwOverride);

      dirty.add(nodeName);
      addedNodeNames.add(nodeName);
      addedCount++;
    }

    // 2. Remove nodes no longer present in the new topology -- same
    // stop(hard)+delete(tolerate "already gone") sequence as destroy().
    for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
      if (topo.nodes[nodeName]) continue;
      onProgress(`removing node ${nodeName} (vmid ${nodeState.vmid})...`);
      try {
        await pve.stopVm(nodeState.vmid, { graceful: false });
      } catch (e) {
        // already stopped/gone -- fine, still attempt delete below
      }
      try {
        await pve.deleteVm(nodeState.vmid);
      } catch (e) {
        if (!/does not exist/i.test(e.message)) throw e;
        onProgress(`  -> ${nodeName} (vmid ${nodeState.vmid}) already gone, skipping`);
      }
      delete state.nodes[nodeName];
      writeState(name, state);
      removedCount++;
    }

    // 3. Reconcile every surviving node's hw/identity against its live
    // Proxmox config -- only patch (and mark dirty) whatever actually
    // differs from the saved YAML.
    for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
      const nodeSpec = topo.nodes[nodeName];
      if (nodeState.kind !== nodeSpec.kind) {
        throw new Error(`Node "${nodeName}": kind changed from "${nodeState.kind}" to "${nodeSpec.kind}" -- destroy and redeploy instead of update`);
      }
      // Same "can't in-place patch a different golden disk" reasoning as
      // the kind check above -- a version change means cloning from a
      // different template's disk, not a hardware tweak. `|| undefined` on
      // both sides normalizes "no version" (missing key vs. an empty
      // string) to the same value, so two different ways of saying
      // "default version" don't get treated as a change.
      if ((nodeState.version || undefined) !== (nodeSpec.version || undefined)) {
        throw new Error(`Node "${nodeName}": version changed from "${nodeState.version || '(default)'}" to "${nodeSpec.version || '(default)'}" -- destroy and redeploy instead of update`);
      }
      const profile = vendors.requireProfile(nodeSpec.kind, nodeSpec.version);
      const hw = (nodeHw[nodeName] = profile.hw);
      // Newly-added nodes (from step 1) have no live config to diff against
      // yet -- skip straight to wiring (step 5), where a missing cfgByNode
      // entry is treated as "always differs" anyway.
      if (addedNodeNames.has(nodeName)) continue;

      const cfg = (cfgByNode[nodeName] = await pve.getVmConfig(nodeState.vmid));

      const hwPatch = {};
      const desiredCores = nodeSpec.cores || hw.cores;
      const desiredMemory = nodeSpec.memory || hw.memory;
      if (Number(cfg.cores) !== desiredCores) hwPatch.cores = desiredCores;
      if (Number(cfg.memory) !== desiredMemory) hwPatch.memory = desiredMemory;
      if (Object.keys(hwPatch).length) {
        onProgress(`${nodeName}: hw changed (cores ${cfg.cores}->${desiredCores}, memory ${cfg.memory}->${desiredMemory}MB)`);
        await pve.setVmConfig(nodeState.vmid, hwPatch);
        dirty.add(nodeName);
      }

      // uuid/mac -- only touch fields explicitly pinned in the YAML, same
      // "only set when present" semantics deploy() already uses.
      const live = identity.parseIdentity(cfg);
      if (nodeSpec.uuid && live.uuid !== nodeSpec.uuid) {
        onProgress(`${nodeName}: uuid changed -- pinning ${nodeSpec.uuid}`);
        await identity.applyIdentity(nodeState.vmid, { uuid: nodeSpec.uuid });
        dirty.add(nodeName);
      }
      if (nodeSpec.mac) {
        const macDiff = {};
        for (const [iface, mac] of Object.entries(nodeSpec.mac)) {
          if (live.macs[iface] !== mac) macDiff[iface] = mac;
        }
        if (Object.keys(macDiff).length) {
          onProgress(`${nodeName}: mac changed on ${Object.keys(macDiff).join(', ')}`);
          await identity.applyIdentity(nodeState.vmid, { macs: macDiff });
          // Keep cfgByNode in sync with the mac(s) just pushed -- step 5's
          // wiring diff reuses this same snapshot, and without this it'd
          // still see the pre-patch mac and redundantly setVmConfig the
          // same net value a second time.
          for (const [iface, mac] of Object.entries(macDiff)) {
            cfg[iface] = identity.buildNicValue(cfg[iface], mac);
          }
          dirty.add(nodeName);
        }
      }

      // mgmt IP -- bookkeeping only, no VM patch/restart needed.
      if (nodeSpec.mgmtIp && nodeSpec.mgmtIp !== nodeState.mgmtIp) {
        nodeState.mgmtIp = nodeSpec.mgmtIp;
        nodeState.mgmtPort = nodeSpec.mgmtPort || 443;
        writeState(name, state);
      }
    }

    // 4. Reconcile links/bridges -- new link names get a fresh bridge,
    // removed ones tear theirs down, unchanged ones keep their existing
    // iface (unlike deploy() step 2, this must NOT blindly re-allocate a
    // bridge for a link name it's already seen before). A link that
    // switches to/from `external` gets its auto-provisioned bridge torn
    // down / a fresh one allocated as appropriate.
    let bridgesChanged = false;
    const topoLinkNames = new Set((topo.links || []).map((l) => l.name));
    for (const link of topo.links || []) {
      const existing = state.bridges[link.name];
      if (link.external) {
        if (existing && existing.created) {
          onProgress(`link "${link.name}": now external -- tearing down previously auto-created bridge ${existing.iface}`);
          await net.teardownBridge(existing.iface);
          bridgesChanged = true;
        }
        state.bridges[link.name] = { iface: link.bridge, created: false };
      } else if (existing && existing.created) {
        state.bridges[link.name] = existing; // unchanged, reuse iface as-is
      } else {
        onProgress(`link "${link.name}": provisioning bridge...`);
        const { iface, created } = await net.ensureLinkBridge(labName, link);
        state.bridges[link.name] = { iface, created };
        onProgress(`  -> ${iface}`);
        bridgesChanged = true;
      }
    }
    for (const linkName of Object.keys(state.bridges)) {
      if (topoLinkNames.has(linkName)) continue;
      const bridge = state.bridges[linkName];
      if (bridge.created) {
        onProgress(`removing bridge ${bridge.iface} (link "${linkName}" removed)...`);
        await net.teardownBridge(bridge.iface);
        bridgesChanged = true;
      }
      delete state.bridges[linkName];
    }
    writeState(name, state);
    if (bridgesChanged) {
      onProgress('applying network changes...');
      await net.applyPendingChanges();
    }

    // 5. Reconcile wiring against the live config -- same construction as
    // deploy() steps 3/3b, but only patched (and marked dirty) when it
    // actually differs from what's live. A node with no cfgByNode entry
    // (brand new, from step 1) always "differs", so it gets its full
    // wiring written exactly like a fresh deploy() would.
    const wiredByNode = {};
    for (const link of topo.links || []) {
      for (const ep of link.endpoints || []) {
        (wiredByNode[ep.node] ||= new Set()).add(ep.interface);
      }
    }

    for (const link of topo.links || []) {
      const iface = state.bridges[link.name].iface;
      for (const ep of link.endpoints || []) {
        const nodeState = state.nodes[ep.node];
        if (!nodeState) throw new Error(`Link "${link.name}" references unknown node "${ep.node}"`);
        const hw = nodeHw[ep.node];
        const mac = (topo.nodes[ep.node].mac && topo.nodes[ep.node].mac[ep.interface]) || null;
        const desiredModel = hw.nicModel || 'virtio';
        const live = parseNicConfig((cfgByNode[ep.node] || {})[ep.interface]);
        if (!live || live.bridge !== iface || live.linkDown || live.model !== desiredModel || (mac && live.mac !== mac)) {
          onProgress(`wiring ${ep.node}:${ep.interface} -> ${iface}`);
          await pve.setVmConfig(nodeState.vmid, {
            [ep.interface]: `${identity.nicPrefix(desiredModel, mac)},bridge=${iface},firewall=0`,
          });
          dirty.add(ep.node);
        }
      }
    }

    for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
      const hw = nodeHw[nodeName];
      const wired = wiredByNode[nodeName] || new Set();
      const macMap = topo.nodes[nodeName].mac || {};
      for (let i = 0; i < hw.nics; i++) {
        const iface = `net${i}`;
        if (wired.has(iface)) continue;
        const desiredModel = hw.nicModel || 'virtio';
        const mac = macMap[iface] || null;
        const live = parseNicConfig((cfgByNode[nodeName] || {})[iface]);
        if (live && live.bridge === 'vmbr0' && live.linkDown && live.model === desiredModel && (!mac || live.mac === mac)) continue;
        onProgress(`  ${nodeName}:${iface} not wired to any link -- leaving disconnected`);
        await pve.setVmConfig(nodeState.vmid, {
          [iface]: `${identity.nicPrefix(desiredModel, mac)},bridge=vmbr0,firewall=0,link_down=1`,
        });
        dirty.add(nodeName);
      }
    }

    // 6. Restart every node whose resolved config actually changed --
    // graceful stop (matching routes/node-ops.js's own per-node power
    // route, not destroy()'s hard stop -- this isn't about to delete the
    // VM), then start. Newly-added nodes just start, nothing to stop.
    for (const nodeName of dirty) {
      const nodeState = state.nodes[nodeName];
      if (!nodeState) continue; // removed in step 2, nothing to restart
      if (addedNodeNames.has(nodeName)) {
        onProgress(`starting ${nodeName} (vmid ${nodeState.vmid})...`);
        await pve.startVm(nodeState.vmid);
      } else {
        onProgress(`restarting ${nodeName} (vmid ${nodeState.vmid}) to apply changes...`);
        await pve.stopVm(nodeState.vmid, { graceful: true });
        await pve.startVm(nodeState.vmid);
      }
    }

    writeState(name, state);
    onProgress(`lab "${labName}" updated: ${dirty.size} node(s) restarted, ${addedCount} added, ${removedCount} removed`);
    return state;
  } catch (err) {
    onProgress(`ERROR: ${err.message}`);
    throw err;
  }
}

// Serializes deploy/destroy/update per lab -- the actual implementations
// above do a bunch of read-state/act/write-state steps with real Proxmox
// API calls (hence awaits) in between, so two calls for the *same* lab
// (two browser tabs, or two different logged-in users -- multi-user login
// is a real shipped feature) could otherwise both pass their own initial
// readState() check and race to clone/delete VMs and overwrite each
// other's state.json, permanently orphaning whichever one loses. Keyed by
// the same `name` string every caller already uses, so deploy/destroy/
// update on one lab all share one queue regardless of which action or
// which connection/user issues it. A second call for the same lab isn't
// rejected -- it queues and runs once the first finishes, same "second
// click waits" semantics lab-bridge.js's own per-connection guard already
// gives a *single* connection, just extended across connections/users --
// but it does get an onProgress line first so it's not just silent from
// the caller's side while queued.
function serialized(name, onProgress, fn) {
  const lockKey = `lab:${name}`;
  if (isLocked(lockKey)) onProgress(`waiting for another operation on "${name}" to finish...`);
  return withLock(lockKey, fn);
}

module.exports = {
  allocateVmid,
  deploy: (name, onProgress = () => {}) => serialized(name, onProgress, () => deploy(name, onProgress)),
  destroy: (name, onProgress = () => {}) => serialized(name, onProgress, () => destroy(name, onProgress)),
  update: (name, onProgress = () => {}) => serialized(name, onProgress, () => update(name, onProgress)),
};
