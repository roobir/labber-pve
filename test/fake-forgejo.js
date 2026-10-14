const http = require('http');
const crypto = require('crypto');
const { blobId } = require('../lib/backup/push-forgejo');

// Just enough of Forgejo's REST API (v1) for lib/backup/, kept in memory, as
// described by Forgejo 15's own swagger: /version, the repository (with
// `empty`), branches, paged git trees (PAGE entries a page, small on purpose
// so paging is exercised) and POST /contents with create / update / delete
// operations, which -- like Forgejo -- refuses an update or delete whose sha
// is not the file's current one, and a create over an existing file.
// `fake.files(branch)` reads back { path: content } of a branch's tip.

const PAGE = 3;
const id = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');

function createFakeForgejo({ token = 'good-token', owner = 'home', repo = 'lab-backup' } = {}) {
  const commits = new Map(); // sha -> { files: {path: content}, parent, message }
  const branches = new Map(); // name -> commit sha
  const trees = new Map(); // tree sha -> { commit, prefix }
  const requests = [];
  const base = `/api/v1/repos/${owner}/${repo}`;

  function commit(files, parent, message) {
    const sha = id({ files, parent, message, n: commits.size });
    commits.set(sha, { files, parent, message });
    return sha;
  }

  // The entries of the directory `prefix` ('' = root) of a commit's files.
  function listing(commitSha, prefix, recursive) {
    const files = commits.get(commitSha).files;
    const out = new Map();
    for (const [p, content] of Object.entries(files)) {
      if (prefix && !p.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? p.slice(prefix.length + 1) : p;
      const parts = rest.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const dir = parts.slice(0, i).join('/');
        if (!recursive && i > 1) break;
        const full = prefix ? `${prefix}/${dir}` : dir;
        const treeSha = id({ commitSha, full });
        trees.set(treeSha, { commit: commitSha, prefix: full });
        out.set(dir, { path: dir, type: 'tree', sha: treeSha });
      }
      if (recursive || parts.length === 1) out.set(rest, { path: rest, type: 'blob', sha: blobId(content, 'sha1') });
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  function change(body) {
    const empty = branches.size === 0;
    const from = body.branch || 'main';
    const target = body.new_branch || from;
    if (!empty && !branches.has(from)) return [404, { message: `branch ${from} does not exist` }];
    if (body.new_branch && branches.has(body.new_branch)) return [422, { message: 'branch already exists' }];
    const files = empty ? {} : { ...commits.get(branches.get(from)).files };
    for (const op of body.files) {
      const current = files[op.path];
      if (op.operation === 'create' && current !== undefined) return [422, { message: `file already exists: ${op.path}` }];
      if (op.operation !== 'create' && (current === undefined || blobId(current, 'sha1') !== op.sha)) return [409, { message: `sha does not match: ${op.path}` }];
      if (op.operation === 'delete') delete files[op.path];
      else files[op.path] = Buffer.from(op.content, 'base64').toString('utf-8');
    }
    const sha = commit(files, empty ? null : branches.get(from), body.message);
    branches.set(target, sha);
    return [201, { commit: { sha } }];
  }

  function route(method, url, body) {
    const u = new URL(url, 'http://x');
    if (u.pathname === base && method === 'GET') {
      return [200, { full_name: `${owner}/${repo}`, private: true, empty: branches.size === 0, default_branch: 'main', permissions: { push: true } }];
    }
    let m;
    if ((m = new RegExp(`^${base}/branches/(.+)$`).exec(u.pathname)) && method === 'GET') {
      const at = branches.get(decodeURIComponent(m[1]));
      return at ? [200, { name: m[1], commit: { id: at } }] : [404, { message: 'branch not found' }];
    }
    if ((m = new RegExp(`^${base}/git/trees/(\\w+)$`).exec(u.pathname)) && method === 'GET') {
      const where = commits.has(m[1]) ? { commit: m[1], prefix: '' } : trees.get(m[1]);
      if (!where) return [404, { message: 'tree not found' }];
      const all = listing(where.commit, where.prefix, u.searchParams.get('recursive') === 'true');
      const page = Number(u.searchParams.get('page') || 1);
      const perPage = Math.min(Number(u.searchParams.get('per_page') || PAGE), PAGE);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      return [200, { sha: m[1], tree: slice, page, total_count: all.length, truncated: all.length > page * perPage }];
    }
    if (u.pathname === `${base}/contents` && method === 'POST') return change(body);
    return [404, { message: `fake: no route ${method} ${u.pathname}` }];
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, body });
      let answer;
      if (req.url === '/api/v1/version') answer = [200, { version: '15.0.9+gitea-1.22.0' }];
      else if (req.headers.authorization === `token ${token}`) answer = route(req.method, req.url, body);
      else answer = [401, { message: `access token does not exist [sha: ${String(req.headers.authorization || '').slice(6)}]` }]; // as Forgejo 15 does
      res.writeHead(answer[0], { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer[1]));
    });
  });

  return {
    server,
    requests,
    commitTo: (branch, files, message) => branches.set(branch, commit(files, branches.get(branch) || null, message)),
    files: (branch = 'main') => (branches.has(branch) ? commits.get(branches.get(branch)).files : null),
    commitCount: () => commits.size,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}/${owner}/${repo}`))),
  };
}

module.exports = { createFakeForgejo };
