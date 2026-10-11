const identity = require('../node-identity');

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

// { <node>: Set of interface names some link's endpoint wires up }
function wiredInterfaces(topo) {
  const wired = {};
  for (const link of topo.links || []) {
    for (const ep of link.endpoints || []) (wired[ep.node] ||= new Set()).add(ep.interface);
  }
  return wired;
}

// The netN value to write: wired to a lab bridge, or (bridge null) parked
// link-down on vmbr0 -- the placeholder bridge a golden template ships with,
// so an unused NIC never ends up live on the physical network.
function nicValue(model, mac, bridge) {
  const prefix = identity.nicPrefix(model, mac);
  return bridge ? `${prefix},bridge=${bridge},firewall=0` : `${prefix},bridge=vmbr0,firewall=0,link_down=1`;
}

module.exports = { parseNicConfig, wiredInterfaces, nicValue };
