const http = require('http');
const https = require('https');

// The REST client backups talk to the git server through: GitHub,
// GitHub Enterprise Server (API under /api/v3) or Forgejo / Gitea (/api/v1).
// Plain https rather than a client library: a token, JSON in and out, and
// TLS that can trust one extra certificate (a self-signed server) or --
// explicitly -- not verify at all. No user name is needed with either: the
// token says who it is.
//
// parseRepoUrl('https://git.example.com/home/lab-backup.git')
//   -> { origin: 'https://git.example.com', owner: 'home', repo: 'lab-backup', webBase }

const TIMEOUT_MS = 120000;
const LABELS = { github: 'GitHub', forgejo: 'Forgejo' };

function parseRepoUrl(url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch (e) {
    throw new Error('repository URL must look like https://git.example.com/owner/repo');
  }
  // https://user:TOKEN@host/... would put the token wherever the URL goes:
  // the settings page, the activity log, the backup itself.
  if (u.username || u.password) throw new Error('take the user name / token out of the URL -- the token goes in the access token field');
  const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (!['https:', 'http:'].includes(u.protocol) || parts.length !== 2) {
    throw new Error('repository URL must look like https://git.example.com/owner/repo');
  }
  const origin = `${u.protocol}//${u.host}`;
  return { origin, owner: parts[0], repo: parts[1], webBase: `${origin}/${parts[0]}/${parts[1]}` };
}

function apiBase(kind, origin) {
  if (kind === 'forgejo') return `${origin}/api/v1`;
  return origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
}

// Certificate errors say what to change in Settings -> Backup.
function tlsHint(err) {
  if (/certificate|self[- ]signed|UNABLE_TO_VERIFY|CERT_/i.test(`${err.code} ${err.message}`)) {
    err.message = `the server's TLS certificate is not trusted (${err.code || err.message}) -- paste the server's certificate under "Trusted certificate", or untick "Verify TLS"`;
  }
  return err;
}

// request(agent, method, url, { token, body, label }) -> parsed JSON; a
// non-2xx answer rejects with err.status set.
function request(agent, method, url, { token, body, label }) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method,
      agent,
      headers: {
        ...(token ? { Authorization: `token ${token}` } : {}),
        Accept: 'application/json',
        'User-Agent': 'labber-pve-backup',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text.slice(0, 200) }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
        // Forgejo repeats a rejected token in its message ("access token does
        // not exist [sha: <token>]"); this message reaches the activity log.
        const said = String((data && data.message) || '');
        const err = new Error(`${label} ${method} ${url.pathname}: ${res.statusCode} ${token ? said.split(token).join('***') : said}`.trim());
        err.status = res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${label} did not answer within ${TIMEOUT_MS / 1000}s`)));
    req.on('error', (err) => reject(tlsHint(err)));
    if (payload) req.write(payload);
    req.end();
  });
}

const agentFor = (origin, { verifyTls = true, caCert = '' }) => (origin.startsWith('https:')
  ? new https.Agent({ rejectUnauthorized: !!verifyTls, ca: caCert && caCert.trim() ? caCert : undefined })
  : undefined);

// Which kind of server is this? github.com is GitHub; otherwise a server that
// answers GET /api/v1/version (no token needed) is Forgejo / Gitea, and
// anything else is taken to be GitHub Enterprise.
async function detect(repoUrl, tls = {}) {
  const { origin } = parseRepoUrl(repoUrl);
  if (origin === 'https://github.com') return 'github';
  try {
    const answer = await request(agentFor(origin, tls), 'GET', new URL(`${origin}/api/v1/version`), { label: 'server' });
    if (answer && typeof answer.version === 'string') return 'forgejo';
  } catch (err) {
    if (!err.status) throw err; // unreachable / TLS: say so now, not as a confusing 404 later
  }
  return 'github';
}

// client({ repoUrl, token, kind, verifyTls, caCert }) -> { call(method, path, body), repo, kind, label }
// `{repo}` in a path stands for repos/<owner>/<repo>.
function client({ repoUrl, token, kind = 'github', verifyTls = true, caCert = '' }) {
  if (!token) throw new Error('no access token saved');
  const repo = parseRepoUrl(repoUrl);
  const base = apiBase(kind, repo.origin);
  const agent = agentFor(repo.origin, { verifyTls, caCert });
  const label = LABELS[kind] || 'server';
  const call = (method, path, body) => request(agent, method, new URL(`${base}${path.replace('{repo}', `repos/${repo.owner}/${repo.repo}`)}`), { token, body, label });
  return { call, repo, kind, label };
}

module.exports = { client, detect, parseRepoUrl, apiBase };
