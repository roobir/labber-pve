const pve = require('./proxmox-client');
const vendors = require('./vendor-profiles');
const configStore = require('./config-store');
const { listLabs, parseTopology } = require('./lab-files');

// The template editor (Settings -> Templates): each device kind's versions
// (label -> template vmid), which is the default, which labs use them, and
// the templates that actually exist in Proxmox. Edits only change labber-pve's
// mapping -- a VM is never deleted from Proxmox here.

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

// { [kind]: { default: [ "lab/node", ... ], versions: { [label]: [ ... ] } } }
// A node without `version:` clones the kind's default.
function usageByKind() {
  const usage = {};
  for (const file of listLabs()) {
    let topo;
    try {
      topo = parseTopology(file);
    } catch (err) {
      continue; // a broken lab file uses nothing
    }
    for (const [node, spec] of Object.entries(topo.nodes || {})) {
      const u = (usage[spec.kind] ||= { default: [], versions: {} });
      const where = `${file.replace(/\.lab\.yml$/, '')}/${node}`;
      if (spec.version) (u.versions[spec.version] ||= []).push(where);
      else u.default.push(where);
    }
  }
  return usage;
}

async function proxmoxTemplates() {
  try {
    const vms = await pve.listVms();
    return { ok: true, vms: vms.map((v) => ({ vmid: Number(v.vmid), name: v.name || '', template: Number(v.template) === 1 })) };
  } catch (err) {
    return { ok: false, error: err.message, vms: [] };
  }
}

async function catalog() {
  const config = configStore.get();
  const usage = usageByKind();
  const px = await proxmoxTemplates();
  const byVmid = new Map(px.vms.map((v) => [v.vmid, v]));
  const kinds = vendors.listKinds().map((k) => {
    const defaultVmid = config.templates[k.kind] ? Number(config.templates[k.kind]) : null;
    const u = usage[k.kind] || { default: [], versions: {} };
    const versions = Object.entries(config.templateVersions[k.kind] || {}).map(([label, vmid]) => {
      const vm = byVmid.get(Number(vmid));
      const isDefault = Number(vmid) === defaultVmid;
      return {
        label,
        vmid: Number(vmid),
        name: vm ? vm.name : null,
        inProxmox: px.ok ? !!vm : null, // null = couldn't ask
        isTemplate: vm ? vm.template : null,
        isDefault,
        usedBy: [...(u.versions[label] || []), ...(isDefault ? u.default : [])],
      };
    }).sort((a, b) => b.isDefault - a.isDefault || a.label.localeCompare(b.label, undefined, { numeric: true }));
    return { kind: k.kind, label: k.label, defaultVmid, versions, defaultUsers: u.default.length };
  });
  return {
    kinds,
    proxmox: { ok: px.ok, error: px.error || null, templates: px.vms.filter((v) => v.template).map(({ vmid, name }) => ({ vmid, name })) },
  };
}

// Does this vmid look right for this kind? Each check: { level: ok|warn|error, text }.
async function check(kind, vmid) {
  const profile = vendors.getProfile(kind);
  if (!profile) throw fail(404, `unknown device kind "${kind}"`);
  const id = Number(vmid);
  const px = await proxmoxTemplates();
  if (!px.ok) throw fail(502, `can't reach Proxmox: ${px.error}`);
  const vm = px.vms.find((v) => v.vmid === id);
  if (!vm) return { vmid: id, checks: [{ level: 'error', text: `VM ${id} does not exist in Proxmox` }] };
  const cfg = await pve.getVmConfig(id);
  const hw = profile.hw;
  const checks = [];
  const add = (level, text) => checks.push({ level, text });
  add(vm.template ? 'ok' : 'error', vm.template ? `${id} is a template (${vm.name})` : `${id} (${vm.name}) is a VM, not a template -- convert it in Proxmox (More -> Convert to template)`);
  add(cfg[hw.diskBus] ? 'ok' : 'error', cfg[hw.diskBus] ? `boot disk on ${hw.diskBus}` : `no disk on ${hw.diskBus}, which ${profile.label} boots from`);
  const bios = cfg.bios || 'seabios';
  add(bios === hw.bios ? 'ok' : 'error', bios === hw.bios ? `BIOS ${bios}` : `BIOS is ${bios}, ${profile.label} needs ${hw.bios}`);
  if (hw.bios === 'ovmf' && !cfg.efidisk0) add('warn', 'UEFI without an EFI disk -- clones boot with temporary EFI variables');
  // Proxmox may store a pinned version ("pc-q35-8.1"); compare the family.
  const family = (m) => (/q35/.test(m || '') ? 'q35' : 'default (i440fx)');
  if (family(cfg.machine) !== family(hw.machine)) add('warn', `machine type is ${family(cfg.machine)}, the profile uses ${family(hw.machine)}`);
  if (hw.serial0) add(cfg.serial0 ? 'ok' : 'warn', cfg.serial0 ? 'serial console present' : 'no serial console -- console runbooks need one (edit hw -> serial0)');
  return { vmid: id, checks };
}

function kindState(kind) {
  if (!vendors.getProfile(kind)) throw fail(404, `unknown device kind "${kind}"`);
  const config = configStore.get();
  return { versions: { ...(config.templateVersions[kind] || {}) }, defaultVmid: config.templates[kind] || '' };
}

async function addVersion(kind, { label, vmid, replace, makeDefault }) {
  const { versions, defaultVmid } = kindState(kind);
  label = String(label || '').trim();
  if (!LABEL_RE.test(label)) throw fail(400, 'a version label is letters, digits, dot, dash or underscore (e.g. 17.5 or r81-20)');
  if (versions[label] && !replace) throw fail(409, `version "${label}" already exists -- choose "replace" to point it at another template`);
  const id = Number(vmid);
  const vm = (await proxmoxTemplates()).vms.find((v) => v.vmid === id);
  if (!vm) throw fail(400, `VM ${vmid} does not exist in Proxmox`);
  if (!vm.template) throw fail(400, `VM ${id} is not a template -- convert it in Proxmox first`);
  versions[label] = String(id);
  configStore.setKindTemplates(kind, versions, makeDefault || !defaultVmid ? id : defaultVmid);
}

function inUse(kind, label) {
  const { versions, defaultVmid } = kindState(kind);
  const u = usageByKind()[kind] || { default: [], versions: {} };
  return [...(u.versions[label] || []), ...(String(versions[label]) === String(defaultVmid) ? u.default : [])];
}

async function setDefault(kind, label) {
  const { versions } = kindState(kind);
  if (!versions[label]) throw fail(404, `no version "${label}"`);
  configStore.setKindTemplates(kind, versions, versions[label]);
}

async function renameVersion(kind, label, { newLabel, force }) {
  const { versions, defaultVmid } = kindState(kind);
  newLabel = String(newLabel || '').trim();
  if (!versions[label]) throw fail(404, `no version "${label}"`);
  if (!LABEL_RE.test(newLabel)) throw fail(400, 'a version label is letters, digits, dot, dash or underscore');
  if (versions[newLabel]) throw fail(409, `version "${newLabel}" already exists`);
  const pinned = (usageByKind()[kind] || { versions: {} }).versions[label] || [];
  if (pinned.length && !force) throw fail(409, `labs pin version "${label}" (${pinned.join(', ')}) -- they would need updating`, { usedBy: pinned });
  versions[newLabel] = versions[label];
  delete versions[label];
  configStore.setKindTemplates(kind, versions, defaultVmid);
}

async function removeVersion(kind, label, { force }) {
  const { versions, defaultVmid } = kindState(kind);
  if (!versions[label]) throw fail(404, `no version "${label}"`);
  const isDefault = String(versions[label]) === String(defaultVmid);
  const others = Object.entries(versions).filter(([l]) => l !== label);
  if (isDefault && others.length) throw fail(409, `"${label}" is the default -- make another version the default first`);
  const users = inUse(kind, label);
  if (users.length && !force) throw fail(409, `used by ${users.join(', ')} -- those labs could no longer deploy`, { usedBy: users });
  delete versions[label];
  configStore.setKindTemplates(kind, versions, isDefault ? '' : defaultVmid);
}

module.exports = { catalog, check, addVersion, setDefault, renameVersion, removeVersion };
