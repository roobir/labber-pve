// Settings -> Backup (lib/backup/): the repository, token, TLS, schedule,
// "test connection", "back up now" and the last backup's outcome. Test and
// back-up-now save the form first, so they always use what is on screen.
// The saved token is never sent back -- an empty token field keeps it.
(function () {
  const navItem = document.querySelector('#settings-nav [data-panel="backup"]');
  const form = document.getElementById('backup-form');
  if (!navItem || !form) return;

  const $ = (id) => document.getElementById(id);
  const messageEl = $('backup-message');
  const lastEl = $('backup-last');
  const daySelect = $('backup-day');
  const testBtn = $('backup-test-btn');
  const runBtn = $('backup-run-btn');
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function setMessage(text, isError) {
    messageEl.textContent = text || '';
    messageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  async function call(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.last) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  }

  function fillDays(frequency, selected) {
    const options = frequency === 'weekly'
      ? WEEKDAYS.map((name, i) => [i, name])
      : Array.from({ length: 28 }, (_, i) => [i + 1, `${i + 1}`]);
    daySelect.replaceChildren(...options.map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })));
    daySelect.value = String(selected);
    daySelect.disabled = frequency === 'off';
    $('backup-time').disabled = frequency === 'off';
  }

  function renderLast(view) {
    const last = view.last;
    lastEl.replaceChildren();
    if (!last) {
      lastEl.textContent = 'no backup yet';
      return;
    }
    const when = `${new Date(last.at).toLocaleString()} -- ${last.trigger === 'scheduled' ? 'scheduled' : `${last.trigger} by ${last.user}`}: `;
    const status = Object.assign(document.createElement('span'), {
      className: last.ok ? 'backup-ok' : 'backup-failed',
      textContent: !last.ok ? `failed: ${last.error}` : last.changed ? 'done' : 'done, nothing had changed',
    });
    lastEl.append(when, status);
    if (last.ok && /^https?:\/\//.test(last.url || '')) {
      const link = Object.assign(document.createElement('a'), { href: last.url, target: '_blank', rel: 'noopener noreferrer', textContent: ` commit ${last.commit.slice(0, 8)}` });
      lastEl.append(link);
    }
    if (last.counts) lastEl.append(` (${last.counts.labs} labs, ${last.counts.runbookFiles} runbook files, ${last.counts.activityDays} activity days)`);
  }

  function render(view) {
    $('backup-repo').value = view.repoUrl;
    $('backup-server').value = view.serverType;
    $('backup-branch').value = view.branch;
    $('backup-folder').value = view.folder;
    $('backup-token').value = '';
    $('backup-token').placeholder = view.tokenSaved ? 'saved -- leave empty to keep it' : 'a token that can push to this repository';
    $('backup-verify-tls').checked = view.verifyTls;
    $('backup-ca').value = view.caCert;
    $('backup-runs').checked = view.includeRuns;
    $('backup-frequency').value = view.schedule.frequency;
    fillDays(view.schedule.frequency, view.schedule.day);
    $('backup-time').value = view.schedule.time;
    $('backup-next').textContent = view.nextRun
      ? `next scheduled backup: ${new Date(view.nextRun).toLocaleString()} (the server runs it at ${view.schedule.time} ${view.timeZone} time)`
      : view.schedule.frequency === 'off' ? 'no scheduled backups' : 'scheduled backups start once a repository and token are saved';
    renderLast(view);
  }

  const values = () => ({
    repoUrl: $('backup-repo').value,
    serverType: $('backup-server').value,
    branch: $('backup-branch').value,
    folder: $('backup-folder').value,
    token: $('backup-token').value,
    verifyTls: $('backup-verify-tls').checked,
    caCert: $('backup-ca').value,
    includeRuns: $('backup-runs').checked,
    schedule: { frequency: $('backup-frequency').value, day: Number(daySelect.value), time: $('backup-time').value },
  });

  // The dashboard's backup banner listens for this (backup-banner.js).
  const changed = () => window.dispatchEvent(new Event('backup:changed'));

  async function save() {
    const view = await call('PUT', '/api/backup/settings', values());
    render(view);
    changed();
    return view;
  }

  // Runs `action` with the buttons disabled; any error lands in the message line.
  async function busy(text, action) {
    setMessage(text);
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    try {
      await action();
    } catch (err) {
      setMessage(err.message, true);
    } finally {
      for (const b of form.querySelectorAll('button')) b.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy('saving…', async () => { await save(); setMessage('saved'); });
  });
  testBtn.addEventListener('click', () => busy('checking the repository…', async () => {
    await save();
    const r = await call('POST', '/api/backup/test');
    setMessage(`ok: ${r.server} repository ${r.repo} (${r.private ? 'private' : 'PUBLIC -- consider a private repository'}), the token can push`, !r.private);
  }));
  runBtn.addEventListener('click', () => busy('backing up… (this can take a minute)', async () => {
    await save();
    const r = await call('POST', '/api/backup/run');
    render(r);
    changed();
    setMessage(r.last.ok ? 'backup done' : `backup failed: ${r.last.error}`, !r.last.ok);
  }));
  // 1 = the 1st of the month, or Monday
  $('backup-frequency').addEventListener('change', (e) => fillDays(e.target.value, 1));
  navItem.addEventListener('click', () => {
    setMessage('');
    call('GET', '/api/backup').then(render).catch((err) => setMessage(err.message, true));
  });
})();
