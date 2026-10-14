// GitHub / GitHub Enterprise: one backup = one commit that REPLACES the
// backup folder on the branch with exactly the files given, through the
// git-data API (no clone, no git binary): a tree of the files, a root tree
// with that folder swapped in, a commit, then the branch moved --
// fast-forward only, so a concurrent push to the branch is never overwritten
// (we retry once on top of it). When the result is identical to the
// branch's current tree, no commit is made.
//
// pushGithub(gh, { branch, folder, files: [{ path, content }], message })
//   -> { changed, commit }   (called through push.js)

// A branch like backups/prod keeps its slash in the ref URL.
const refPath = (branch) => branch.split('/').map(encodeURIComponent).join('/');

async function branchHead(gh, branch) {
  try {
    return (await gh.call('GET', `/{repo}/git/ref/heads/${refPath(branch)}`)).object.sha;
  } catch (err) {
    if (err.status !== 404 && err.status !== 409) throw err;
  }
  // No such branch: start it from the default branch, or -- in an empty
  // repository, where the git-data API refuses to work -- with a first file.
  const info = await gh.call('GET', '/{repo}');
  try {
    const base = (await gh.call('GET', `/{repo}/git/ref/heads/${refPath(info.default_branch)}`)).object.sha;
    await gh.call('POST', '/{repo}/git/refs', { ref: `refs/heads/${branch}`, sha: base });
    return base;
  } catch (err) {
    if (err.status !== 404 && err.status !== 409) throw err;
  }
  const readme = '# labber-pve backups\n\nEach folder holds one labber instance\'s backup; every backup is one commit.\n';
  const created = await gh.call('PUT', '/{repo}/contents/README.md', {
    message: 'labber backup: start the repository',
    content: Buffer.from(readme).toString('base64'),
    branch,
  });
  return created.commit.sha;
}

async function attempt(gh, { branch, folder, files, message }) {
  const head = await branchHead(gh, branch);
  const rootTree = (await gh.call('GET', `/{repo}/git/commits/${head}`)).tree.sha;
  const folderTree = await gh.call('POST', '/{repo}/git/trees', {
    tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
  });
  const newRoot = await gh.call('POST', '/{repo}/git/trees', {
    base_tree: rootTree,
    tree: [{ path: folder, mode: '040000', type: 'tree', sha: folderTree.sha }],
  });
  if (newRoot.sha === rootTree) return { changed: false, commit: head };
  const commit = await gh.call('POST', '/{repo}/git/commits', { message, tree: newRoot.sha, parents: [head] });
  await gh.call('PATCH', `/{repo}/git/refs/heads/${refPath(branch)}`, { sha: commit.sha, force: false });
  return { changed: true, commit: commit.sha };
}

async function pushGithub(gh, options) {
  try {
    return await attempt(gh, options);
  } catch (err) {
    // 422 on the ref update = the branch moved while we built the commit
    if (err.status !== 422 || !/refs\/heads/.test(err.message)) throw err;
    return attempt(gh, options);
  }
}

module.exports = { pushGithub };
