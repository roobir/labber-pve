// Steps that act on labber-pve's own state rather than on a device:
//
//   lab:
//     setMgmtIp: { ip: "{{steps.getip.out.ip}}", port: 443 }
//         saves the IP on the node's dashboard card + lab file, so "web ui",
//         "web rp" and the API relay can reach it from now on
//     assertIdentity: { uuid: "{{store.lic.uuid}}", mac: "{{store.lic.mac}}" }
//         fails unless the node's live SMBIOS UUID / net0 MAC match --
//         licenses are bound to these, so check before spending one

const ACTIONS = ['setMgmtIp', 'assertIdentity'];

function validate(spec) {
  if (!spec || typeof spec !== 'object') return ['lab must be an object'];
  const keys = Object.keys(spec);
  if (keys.length !== 1 || !ACTIONS.includes(keys[0])) return [`lab needs exactly one of: ${ACTIONS.join(', ')}`];
  if (keys[0] === 'setMgmtIp' && !(spec.setMgmtIp && spec.setMgmtIp.ip)) return ['lab.setMgmtIp needs an ip'];
  return [];
}

async function setMgmtIp({ ip, port }, rt, target) {
  const result = rt.deps.labs.setMgmtIp(target.lab, target.node, ip, port);
  rt.log(`saved mgmt IP ${result.mgmtIp}:${result.mgmtPort} on ${target.node}`);
  return { ip: result.mgmtIp, port: result.mgmtPort };
}

async function assertIdentity({ uuid, mac }, rt, target) {
  const live = await rt.deps.labs.getIdentity(target.lab, target.node);
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  if (uuid && !same(uuid, live.uuid)) throw new Error(`UUID mismatch: expected ${uuid}, node has ${live.uuid}`);
  const liveMac = live.macs.net0;
  if (mac && !same(mac, liveMac)) throw new Error(`MAC mismatch: expected ${mac}, node net0 has ${liveMac}`);
  rt.log(uuid || mac ? 'identity matches' : 'nothing to check (no uuid/mac given)');
  return {};
}

async function run(spec, rt) {
  const target = rt.target();
  const [action] = Object.keys(spec);
  const rendered = rt.render(spec[action]);
  const out = action === 'setMgmtIp' ? await setMgmtIp(rendered, rt, target) : await assertIdentity(rendered, rt, target);
  return { out };
}

module.exports = { key: 'lab', validate, run };
