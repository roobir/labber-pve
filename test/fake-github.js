const http = require('http');
const crypto = require('crypto');

// Just enough of GitHub's REST API (git data + contents + repo) for
// lib/backup/, kept in memory: blobs, flat-path trees, commits, refs.
// Behaves like the real one where the backup code depends on it: an empty
// repository refuses the git-data API (409) until a first file exists,
// unknown refs 404, and a ref update must fast-forward (422 otherwise).
// `fake.files(branch)` reads back { path: content } of a branch's tip.

const sha = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');

function createFakeGitHub({ token = 'good-token', owner = 'NetSec', repo = 'labber', canPush = true } = {}) {
  const objects = new Map(); // sha -> { type, ... }
  const refs = new Map(); // branch -> commit sha
  const requests = [];
  const put = (obj) => { const id = sha(obj); objects.set(id, obj); return id; };
  const treeFiles = (treeSha) => (treeSha ? objects.get(treeSha).files : {});
  const base = `/api/v3/repos/${owner}/${repo}`;

  function commitTo(branch, files, message) {
    const parent = refs.get(branch);
    const tree = put({ type: 'tree', files });
    const commit = put({ type: 'commit', tree, parents: parent ? [parent] : [], message });
    refs.set(branch, commit);
    return commit;
  }

  function route(method, url, body) {
    if (url === base && method === 'GET') {
      return [200, { full_name: `${owner}/${repo}`, private: true, default_branch: 'main', permissions: { push: canPush } }];
    }
    if (url === `${base}/contents/README.md` && method === 'PUT') {
      const commit = commitTo(body.branch, { 'README.md': Buffer.from(body.content, 'base64').toString() }, body.message);
      return [201, { commit: { sha: commit } }];
    }
    if (url.startsWith(`${base}/git/`) && refs.size === 0) return [409, { message: 'Git Repository is empty.' }];
    let m;
    if ((m = /\/git\/ref\/heads\/(.+)$/.exec(url)) && method === 'GET') {
      if (m[1].includes('%2F')) return [404, { message: 'Not Found' }]; // GitHub wants the slash as is
      const at = refs.get(decodeURIComponent(m[1]));
      return at ? [200, { object: { sha: at } }] : [404, { message: 'Not Found' }];
    }
    if (url === `${base}/git/refs` && method === 'POST') {
      refs.set(body.ref.replace('refs/heads/', ''), body.sha);
      return [201, {}];
    }
    if ((m = /\/git\/commits\/(\w+)$/.exec(url)) && method === 'GET') return [200, { tree: { sha: objects.get(m[1]).tree } }];
    if (url === `${base}/git/trees` && method === 'POST') {
      // a tree from scratch, or base_tree with one folder replaced by a tree
      const files = body.base_tree ? { ...treeFiles(body.base_tree) } : {};
      for (const e of body.tree) {
        if (e.type === 'tree') {
          for (const k of Object.keys(files)) if (k.startsWith(`${e.path}/`)) delete files[k];
          for (const [k, v] of Object.entries(treeFiles(e.sha))) files[`${e.path}/${k}`] = v;
        } else files[e.path] = e.content;
      }
      return [201, { sha: put({ type: 'tree', files }) }];
    }
    if (url === `${base}/git/commits` && method === 'POST') {
      return [201, { sha: put({ type: 'commit', tree: body.tree, parents: body.parents, message: body.message }) }];
    }
    if ((m = /\/git\/refs\/heads\/(.+)$/.exec(url)) && method === 'PATCH') {
      const branch = decodeURIComponent(m[1]);
      if (objects.get(body.sha).parents[0] !== refs.get(branch)) return [422, { message: `Update is not a fast forward (refs/heads/${branch})` }];
      refs.set(branch, body.sha);
      return [200, {}];
    }
    return [404, { message: `fake: no route ${method} ${url}` }];
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const [status, data] = req.headers.authorization === `token ${token}` ? route(req.method, req.url, body) : [401, { message: 'Bad credentials' }];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    });
  });

  return {
    server,
    requests,
    commitTo,
    files: (branch = 'main') => (refs.get(branch) ? treeFiles(objects.get(refs.get(branch)).tree) : null),
    commits: (branch = 'main') => {
      const out = [];
      for (let c = refs.get(branch); c; c = objects.get(c).parents[0]) out.push(objects.get(c));
      return out;
    },
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}/${owner}/${repo}`))),
  };
}

module.exports = { createFakeGitHub };
