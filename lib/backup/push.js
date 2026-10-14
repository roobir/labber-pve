const { pushGithub } = require('./push-github');
const { pushForgejo } = require('./push-forgejo');

// One backup = one commit that makes the backup folder on the branch hold
// exactly the files given: changed files updated, new ones added, files no
// longer in labber removed; nothing outside the folder is touched, and when
// nothing changed no commit is made. How that commit is built depends on the
// server (push-github.js, push-forgejo.js).
//
// commitFolder(client, { branch, folder, files: [{ path, content }], message })
//   -> { changed, commit, url }

const FOLDER_RE = /^[A-Za-z0-9._-]{1,100}$/;

async function commitFolder(client, options) {
  if (!FOLDER_RE.test(options.folder || '')) throw new Error('backup folder: one name of letters, digits, dot, dash or underscore');
  if (!options.files.length) throw new Error('nothing to back up');
  const result = client.kind === 'forgejo' ? await pushForgejo(client, options) : await pushGithub(client, options);
  return { ...result, url: `${client.repo.webBase}/commit/${result.commit}` };
}

module.exports = { commitFolder, FOLDER_RE };
