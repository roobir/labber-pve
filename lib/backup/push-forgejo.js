const crypto = require('crypto');

// Forgejo / Gitea: one backup = one commit through the "change files" API
// (POST /repos/{owner}/{repo}/contents), which takes create / update /
// delete operations for many files at once. What the backup folder already
// holds is read from the branch's tree (paged, as Forgejo pages trees); a
// file whose git object id matches the new content is left alone, so an
// unchanged labber makes no commit. Updates and deletes name the object id
// they replace, so a file someone changed on the server meanwhile makes the
// commit fail instead of being overwritten -- the next backup redoes it.
//
// pushForgejo(fj, { branch, folder, files: [{ path, content }], message })
//   -> { changed, commit }   (called through push.js)

const PER_PAGE = 1000; // the most Forgejo returns per tree page

const refPath = (branch) => branch.split('/').map(encodeURIComponent).join('/');

// git's own id for a file's content; sha256 repositories use 64-char ids.
function blobId(content, algorithm) {
  const body = Buffer.from(content, 'utf-8');
  return crypto.createHash(algorithm).update(`blob ${body.length}\0`).update(body).digest('hex');
}

async function branchCommit(fj, branch) {
  try {
    return (await fj.call('GET', `/{repo}/branches/${refPath(branch)}`)).commit.id;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function treeEntries(fj, sha, recursive) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const r = await fj.call('GET', `/{repo}/git/trees/${sha}?recursive=${recursive}&per_page=${PER_PAGE}&page=${page}`);
    const entries = r.tree || [];
    out.push(...entries);
    if (!r.truncated || !entries.length) return out;
  }
}

// The files under `folder` at `commit` -> Map(path inside the folder -> blob id)
async function folderFiles(fj, commit, folder) {
  const files = new Map();
  if (!commit) return files;
  const dir = (await treeEntries(fj, commit, false)).find((e) => e.path === folder && e.type === 'tree');
  if (!dir) return files;
  for (const e of await treeEntries(fj, dir.sha, true)) if (e.type === 'blob') files.set(e.path, e.sha);
  return files;
}

async function pushForgejo(fj, { branch, folder, files, message }) {
  const info = await fj.call('GET', '/{repo}');
  const head = info.empty ? null : await branchCommit(fj, branch);
  // A missing branch starts from the default branch -- so compare with that.
  const base = head || (info.empty ? null : await branchCommit(fj, info.default_branch));
  const have = await folderFiles(fj, base, folder);
  const algorithm = base && base.length === 64 ? 'sha256' : 'sha1';

  const ops = [];
  const wanted = new Set();
  for (const f of files) {
    wanted.add(f.path);
    const id = have.get(f.path);
    if (id === blobId(f.content, algorithm)) continue;
    ops.push({ operation: id ? 'update' : 'create', path: `${folder}/${f.path}`, content: Buffer.from(f.content, 'utf-8').toString('base64'), sha: id });
  }
  for (const [p, id] of have) if (!wanted.has(p)) ops.push({ operation: 'delete', path: `${folder}/${p}`, sha: id });
  if (!ops.length) return { changed: false, commit: base };

  const body = { message, files: ops, branch };
  // A missing branch is made from the default branch; in an empty repository
  // the first commit simply starts `branch`.
  if (!head && !info.empty) Object.assign(body, { branch: info.default_branch, new_branch: branch });
  const result = await fj.call('POST', '/{repo}/contents', body);
  return { changed: true, commit: result.commit.sha };
}

module.exports = { pushForgejo, blobId };
