// Which REST call is which audited action. describe(method, path, body)
// returns { action, target, detail } or null for calls that change nothing
// (connection test, upload preflight, presence heartbeat).
//
// Only fields named here ever reach the log -- never the body as a whole:
// settings carry the Proxmox token, Store entries carry secrets, users carry
// passwords. A change call missing from this table is still recorded, as
// `api.<method>` with its path, so a new route is never silently unaudited.
// Patterns are case-insensitive, like Express's own routing (the middleware
// has already dropped any trailing slash).

const SKIP = [
  /^\/api\/settings\/test$/i,
  /^\/api\/templates\/preflight$/i,
  /^\/api\/presence$/i,
  /^\/api\/backup\/test$/i,
  /^\/api\/backup\/run$/i, // lib/backup/run.js records it, with the outcome and commit
];

const pick = (body, keys) => {
  const out = {};
  for (const k of keys) if (body && body[k] !== undefined) out[k] = body[k];
  return out;
};

// A URL as typed, minus any user:password@ part (a rejected save is still
// recorded -- and must not record a token pasted into the URL).
function withoutCredentials(url) {
  try {
    const u = new URL(String(url));
    u.username = '';
    u.password = '';
    return u.toString();
  } catch (e) {
    return String(url || '').replace(/\/\/[^/@]*@/, '//');
  }
}

// Every lab entry names the lab by its file, as the lab's own routes do, so
// a lab's history (target filter) finds its create / import / duplicate too.
const labFile = (name) => (typeof name === 'string' && name.trim() ? `${name.trim().replace(/\.lab\.yml$/, '')}.lab.yml` : undefined);

// A runbook's target inputs arrive as { lab, node } -- whatever the input's id.
const targetNodes = (inputs) => Object.values(inputs || {})
  .filter((v) => v && typeof v === 'object' && typeof v.lab === 'string' && typeof v.node === 'string')
  .map((v) => `${v.lab}/${v.node}`)
  .join(', ') || undefined;

// [method, path regex, action, (match, body) -> { target, detail }]
const RULES = [
  ['POST', /^\/api\/labs$/i, 'lab.create', (m, b) => ({ target: labFile(b.name) })],
  ['POST', /^\/api\/labs\/import$/i, 'lab.import', (m, b) => ({ target: labFile(b.name) })],
  ['POST', /^\/api\/labs\/([^/]+)\/duplicate$/i, 'lab.duplicate', (m, b) => ({ target: labFile(b.name), detail: { from: m[1] } })],
  ['PUT', /^\/api\/labs\/([^/]+)$/i, 'lab.save', (m) => ({ target: m[1] })],
  ['DELETE', /^\/api\/labs\/([^/]+)$/i, 'lab.delete', (m) => ({ target: m[1] })],
  ['POST', /^\/api\/labs\/([^/]+)\/reservation$/i, 'lab.reserve', (m, b) => ({ target: m[1], detail: pick(b, ['hours', 'note']) })],
  ['DELETE', /^\/api\/labs\/([^/]+)\/reservation$/i, 'lab.release', (m) => ({ target: m[1] })],
  ['POST', /^\/api\/labs\/([^/]+)\/nodes\/([^/]+)\/mgmt-ip$/i, 'node.mgmt-ip', (m, b) => ({ target: `${m[1]}/${m[2]}`, detail: pick(b, ['ip', 'port']) })],
  ['POST', /^\/api\/labs\/([^/]+)\/nodes\/([^/]+)\/identity$/i, 'node.identity', (m, b) => ({ target: `${m[1]}/${m[2]}`, detail: pick(b, ['anchor']) })],
  ['POST', /^\/api\/labs\/([^/]+)\/nodes\/([^/]+)\/power$/i, 'node.power', (m, b) => ({ target: `${m[1]}/${m[2]}`, detail: pick(b, ['action']) })],

  ['POST', /^\/api\/runbooks$/i, 'runbook.create', (m, b) => ({ target: b.name })],
  ['PUT', /^\/api\/runbooks\/([^/]+)\/([^/]+)$/i, 'runbook.save', (m) => ({ target: `${m[1]} ${m[2]}` })],
  ['POST', /^\/api\/runbooks\/([^/]+)\/([^/]+)\/new-version$/i, 'runbook.new-version', (m) => ({ target: `${m[1]} ${m[2]}` })],
  ['POST', /^\/api\/runbooks\/([^/]+)\/([^/]+)\/copy$/i, 'runbook.copy', (m, b) => ({ target: `${m[1]} ${m[2]}`, detail: pick(b, ['newName']) })],
  ['POST', /^\/api\/runbooks\/([^/]+)\/([^/]+)\/lock$/i, 'runbook.lock', (m) => ({ target: `${m[1]} ${m[2]}` })],
  ['DELETE', /^\/api\/runbooks\/([^/]+)\/([^/]+)$/i, 'runbook.delete', (m) => ({ target: `${m[1]} ${m[2]}` })],
  ['POST', /^\/api\/runs$/i, 'run.start', (m, b) => ({
    target: `${b.name || ''} ${b.version || 'latest'}`,
    detail: { nodes: targetNodes(b.inputs), force: b.force || undefined },
  })],

  ['PUT', /^\/api\/store\/([^/]+)$/i, 'store.save', (m, b) => ({ target: m[1], detail: pick(b, ['type']) })],
  ['POST', /^\/api\/store\/([^/]+)\/restore$/i, 'store.restore', (m, b) => ({ target: m[1], detail: pick(b, ['index']) })],
  ['DELETE', /^\/api\/store\/([^/]+)$/i, 'store.delete', (m) => ({ target: m[1] })],

  ['POST', /^\/api\/settings$/i, 'settings.connection', () => ({})],
  ['POST', /^\/api\/settings\/api$/i, 'settings.public-api', (m, b) => ({ detail: pick(b, ['enabled', 'relayEnabled', 'allowedIps']) })],
  ['POST', /^\/api\/storages$/i, 'settings.storage-folder', (m, b) => ({ target: b.id, detail: pick(b, ['parentPath', 'subfolder']) })],
  ['POST', /^\/api\/bridges$/i, 'bridge.create', (m, b) => ({ target: b.iface })],
  ['PUT', /^\/api\/vms\/([^/]+)\/config$/i, 'template.hardware', (m, b) => ({ target: `vm ${m[1]}`, detail: pick(b, ['cores', 'memory', 'cpu', 'bios', 'machine', 'scsihw']) })],
  ['POST', /^\/api\/templates\/build$/i, 'template.build', (m, b) => ({ target: b.kind, detail: pick(b, ['name', 'vmid', 'versionLabel', 'cores', 'memory']) })],
  ['POST', /^\/api\/templates\/finalize$/i, 'template.finalize', (m, b) => ({ target: b.kind, detail: pick(b, ['vmid', 'versionLabel']) })],
  ['POST', /^\/api\/template-catalog\/([^/]+)\/versions$/i, 'template.version-add', (m, b) => ({ target: m[1], detail: pick(b, ['label', 'vmid']) })],
  ['POST', /^\/api\/template-catalog\/([^/]+)\/versions\/([^/]+)\/default$/i, 'template.version-default', (m) => ({ target: `${m[1]} ${m[2]}` })],
  ['POST', /^\/api\/template-catalog\/([^/]+)\/versions\/([^/]+)\/rename$/i, 'template.version-rename', (m, b) => ({ target: `${m[1]} ${m[2]}`, detail: pick(b, ['newLabel']) })],
  ['DELETE', /^\/api\/template-catalog\/([^/]+)\/versions\/([^/]+)$/i, 'template.version-delete', (m) => ({ target: `${m[1]} ${m[2]}` })],

  ['PUT', /^\/api\/backup\/settings$/i, 'backup.settings', (m, b) => ({
    target: b.repoUrl === undefined ? undefined : withoutCredentials(b.repoUrl),
    detail: { ...pick(b, ['serverType', 'branch', 'folder', 'verifyTls', 'includeRuns', 'schedule']), token: b.token ? 'changed' : undefined, trustedCert: b.caCert ? 'set' : undefined },
  })],

  ['POST', /^\/api\/users$/i, 'user.create', (m, b) => ({ target: b.username })],
  ['DELETE', /^\/api\/users\/([^/]+)$/i, 'user.delete', (m) => ({ target: m[1] })],
  ['POST', /^\/api\/relay-tokens$/i, 'token.create', (m, b) => ({ target: b.label, detail: pick(b, ['labScope']) })],
  ['DELETE', /^\/api\/relay-tokens\/([^/]+)$/i, 'token.revoke', (m) => ({ target: m[1] })],
];

function decode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function describe(method, urlPath, body) {
  if (SKIP.some((re) => re.test(urlPath))) return null;
  const b = body && typeof body === 'object' ? body : {};
  for (const [m, re, action, fn] of RULES) {
    if (m !== method) continue;
    const match = re.exec(urlPath);
    if (!match) continue;
    const { target, detail } = fn(match.map((part) => (part === undefined ? part : decode(part))), b);
    return { action, target: target === undefined ? '' : String(target), detail };
  }
  return { action: `api.${method.toLowerCase()}`, target: urlPath };
}

module.exports = { describe };
