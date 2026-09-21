// "Build template from qcow2 (or .iso)" modal: upload an image, watch the
// async upload -> create VM -> import disk/attach ISO -> template build job
// progress by polling /api/templates/build/:jobId, same "frontend polls on
// an interval" pattern the dashboard already uses for /api/status rather
// than a websocket -- simplest thing that works at homelab scale, and
// avoids holding one long-lived request open behind a k8s ingress for a
// multi-GB upload + multi-minute import.
//
// Two distinct progress phases, both feeding the same <progress> bar:
//  1. browser -> app upload -- tracked client-side via XMLHttpRequest's
//     upload.onprogress (plain fetch() has no equivalent, which is why this
//     uses XHR instead for just this one call), since that's real,
//     accurate byte-level progress this page can observe directly.
//  2. app -> Proxmox + the actual VM build -- server-tracked (see
//     template-builder.js's phase/progress fields), polled here the same
//     way the log lines already were.
//
// ISO-based kinds (currently only Check Point Gaia) end at a third state,
// "awaiting-install" rather than "done" -- there's no ready-to-boot disk to
// import, so the job creates a blank disk + boots the ISO and stops there;
// finishing the interactive installer over console is a real manual step,
// then "finalize as template" (POST /api/templates/finalize) converts it.
(function () {
  const overlay = document.getElementById('templates-overlay');
  const openBtn = document.getElementById('templates-btn');
  const closeBtn = document.getElementById('templates-close');
  const minimizeBtn = document.getElementById('templates-minimize');
  const form = document.getElementById('templates-form');
  const kindEl = document.getElementById('tplbuild-kind');
  const nameEl = document.getElementById('tplbuild-name');
  const vmidEl = document.getElementById('tplbuild-vmid');
  const fileEl = document.getElementById('tplbuild-file');
  const diskSizeRow = document.getElementById('tplbuild-disksize-row');
  const diskSizeEl = document.getElementById('tplbuild-disksize');
  const startBtn = document.getElementById('tplbuild-start-btn');
  const messageEl = document.getElementById('tplbuild-message');
  const logEl = document.getElementById('tplbuild-log');
  const progressWrap = document.getElementById('tplbuild-progress-wrap');
  const progressEl = document.getElementById('tplbuild-progress');
  const phaseEl = document.getElementById('tplbuild-phase');
  const finalizeRow = document.getElementById('tplbuild-finalize-row');
  const finalizeBtn = document.getElementById('tplbuild-finalize-btn');
  const versionEl = document.getElementById('tplbuild-version');
  const replaceRowEl = document.getElementById('tplbuild-replace-row');
  const replaceEl = document.getElementById('tplbuild-replace');

  const PHASE_LABELS = {
    uploading: 'uploading',
    'creating-vm': 'creating VM',
    'importing-disk': 'importing disk',
    'setting-boot-order': 'setting boot order',
    starting: 'starting VM',
    'awaiting-install': 'awaiting install',
    'converting-to-template': 'converting to template',
    done: 'done',
    error: 'error',
  };

  let pollTimer = null;
  let loggedLines = 0;
  let xhr = null;
  let currentKind = null; // remembered for the finalize call, which only takes a vmid+kind
  let currentVersionLabel = null; // same reason -- finalize also needs the version this build was for
  let cachedKinds = []; // /api/vendors response, kept for the client-side label-collision hint below

  function setMessage(text, isError) {
    messageEl.textContent = text || '';
    messageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  function setProgress(phase, progress) {
    progressWrap.classList.remove('hidden');
    phaseEl.textContent = PHASE_LABELS[phase] || phase || '';
    if (typeof progress === 'number') {
      progressEl.removeAttribute('indeterminate');
      progressEl.value = progress;
      phaseEl.textContent += ` -- ${progress}%`;
    } else {
      // No `value` attribute at all -- <progress> then renders its native
      // indeterminate/animated state, appropriate for PVE-side steps that
      // don't report a percentage (only their own task log, streamed as
      // regular log lines instead).
      progressEl.removeAttribute('value');
    }
  }

  // /api/vendors already carries `configured`/`templateId` (config-store's
  // per-kind vmid, set once a build finishes) -- this just surfaces it in
  // the kind dropdown so re-opening this modal shows which kinds already
  // have a golden template vs which still need one, instead of that only
  // being visible on the Settings page.
  async function loadKinds() {
    kindEl.innerHTML = '';
    try {
      const res = await fetch('/api/vendors');
      cachedKinds = await res.json();
      for (const k of cachedKinds) {
        const opt = document.createElement('option');
        opt.value = k.kind;
        opt.textContent = k.configured
          ? `✓ ${k.label} -- built (vmid ${k.templateId})`
          : `○ ${k.label} -- no template yet`;
        opt.style.color = k.configured ? 'var(--accent)' : 'var(--dim)';
        kindEl.appendChild(opt);
      }
    } catch (err) {
      cachedKinds = [];
      setMessage('failed to load device kinds', true);
    }
  }

  // Proactively shows the "replace" checkbox as soon as the typed label
  // matches one this kind already has, instead of only finding out via a
  // 409 after clicking submit -- cachedKinds' `versions` map (from
  // /api/vendors) already has everything needed, no extra round trip.
  function checkVersionCollision() {
    const kindInfo = cachedKinds.find((k) => k.kind === kindEl.value);
    const label = versionEl.value.trim();
    const collides = !!(kindInfo && label && kindInfo.versions[label]);
    replaceRowEl.classList.toggle('hidden', !collides);
    if (!collides) replaceEl.checked = false;
  }

  function isIsoSelected() {
    const f = fileEl.files[0];
    return !!f && f.name.toLowerCase().endsWith('.iso');
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function poll(jobId) {
    loggedLines = 0;
    logEl.textContent = '';
    pollTimer = setInterval(async () => {
      let job;
      try {
        const res = await fetch(`/api/templates/build/${jobId}`);
        job = await res.json();
      } catch (err) {
        return; // transient -- keep polling
      }

      if (job.log && job.log.length > loggedLines) {
        logEl.textContent += job.log.slice(loggedLines).join('\n') + '\n';
        loggedLines = job.log.length;
        logEl.scrollTop = logEl.scrollHeight;
      }
      setProgress(job.phase, job.progress);

      if (job.status === 'done') {
        const msg = `done -- template vmid ${job.vmid} saved as "${currentKind}" version "${currentVersionLabel}"`;
        setMessage(msg);
        WindowManager.notify('templates', msg, false);
        stopPolling();
        setEditingEnabled(true);
      } else if (job.status === 'awaiting-install') {
        const msg = `vmid ${job.vmid} is running the installer -- open its console, finish the install, shut it down, then finalize below`;
        setMessage(msg);
        WindowManager.notify('templates', msg, false);
        finalizeRow.classList.remove('hidden');
        finalizeBtn.dataset.vmid = job.vmid;
        stopPolling();
        setEditingEnabled(true);
      } else if (job.status === 'error') {
        const msg = job.error || 'build failed';
        setMessage(msg, true);
        WindowManager.notify('templates', msg, true);
        stopPolling();
        setEditingEnabled(true);
      }
    }, 1500);
  }

  async function finalize() {
    const vmid = finalizeBtn.dataset.vmid;
    finalizeBtn.disabled = true;
    setMessage('finalizing...');
    try {
      const res = await fetch('/api/templates/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vmid, kind: currentKind, versionLabel: currentVersionLabel }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'finalize failed');
      setMessage(`done -- template vmid ${vmid} saved as "${currentKind}" version "${currentVersionLabel}"`);
      finalizeRow.classList.add('hidden');
    } catch (err) {
      setMessage(err.message, true);
    } finally {
      finalizeBtn.disabled = false;
    }
  }

  function setEditingEnabled(enabled) {
    startBtn.disabled = !enabled;
    kindEl.disabled = !enabled;
    versionEl.disabled = !enabled;
    replaceEl.disabled = !enabled;
    nameEl.disabled = !enabled;
    vmidEl.disabled = !enabled;
    fileEl.disabled = !enabled;
    diskSizeEl.disabled = !enabled;
  }

  function uploadFile(body) {
    return new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/templates/build');

      xhr.upload.addEventListener('progress', (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.round((ev.loaded / ev.total) * 100);
        setProgress('uploading', pct);
        setMessage(`uploading... ${pct}%`);
      });

      xhr.addEventListener('load', () => {
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (err) {
          return reject(new Error('unexpected response from server'));
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        // conflict carried on the Error object (not just its message) so
        // start()'s catch can react to it specifically -- reveal the
        // "replace" checkbox instead of just showing red text and leaving
        // the user to guess what to do next.
        const err = new Error(data.error || `upload failed (HTTP ${xhr.status})`);
        err.conflict = !!data.conflict;
        reject(err);
      });

      xhr.addEventListener('error', () => reject(new Error('upload failed (network error)')));
      xhr.addEventListener('abort', () => reject(new Error('upload cancelled')));

      xhr.send(body);
    });
  }

  async function start(e) {
    e.preventDefault();
    if (!fileEl.files[0]) {
      setMessage('choose a file first', true);
      return;
    }
    const versionLabel = versionEl.value.trim();
    if (!versionLabel) {
      setMessage('a version label is required (e.g. "9.1.6" or "sonic-vs-v2")', true);
      return;
    }
    currentKind = kindEl.value;
    currentVersionLabel = versionLabel;
    setEditingEnabled(false);
    setMessage('uploading... 0%');
    logEl.textContent = '';
    finalizeRow.classList.add('hidden');
    setProgress('uploading', 0);

    const body = new FormData();
    body.append('kind', currentKind);
    body.append('versionLabel', versionLabel);
    body.append('replaceExisting', replaceEl.checked ? 'true' : 'false');
    body.append('name', nameEl.value.trim());
    body.append('vmid', vmidEl.value.trim());
    body.append('qcow2', fileEl.files[0]);
    if (isIsoSelected() && diskSizeEl.value.trim()) {
      body.append('diskSizeGB', diskSizeEl.value.trim());
    }

    try {
      const data = await uploadFile(body);
      setMessage('building...');
      poll(data.jobId);
    } catch (err) {
      if (err.conflict) replaceRowEl.classList.remove('hidden');
      setMessage(err.message, true);
      WindowManager.notify('templates', err.message, true);
      setEditingEnabled(true);
    } finally {
      xhr = null;
    }
  }

  // A job is "in flight" from the moment start() kicks off the upload until
  // poll() sees a terminal status (done/awaiting-install/error) -- xhr is
  // non-null during the upload leg, pollTimer during the build leg.
  function jobInFlight() {
    return !!xhr || !!pollTimer;
  }

  // Reopening used to unconditionally reset the form and abort whatever was
  // running (stopPolling() + xhr.abort()) -- meaning walking away and
  // coming back via the header button, not the minimize/restore path,
  // silently killed an in-progress upload/build with no warning. Now only
  // resets when nothing is actually running, so the only way to lose an
  // in-flight job is to explicitly want to (there's no "cancel" button --
  // it just runs to completion in the background either way).
  function open() {
    overlay.classList.remove('hidden');
    if (jobInFlight()) return;
    setEditingEnabled(true);
    setMessage('');
    logEl.textContent = '';
    progressWrap.classList.add('hidden');
    progressEl.removeAttribute('value');
    diskSizeRow.classList.add('hidden');
    finalizeRow.classList.add('hidden');
    replaceRowEl.classList.add('hidden');
    form.reset();
    loadKinds();
  }

  function close() {
    overlay.classList.add('hidden');
  }

  // Never touches xhr/pollTimer -- the upload/build keeps running exactly
  // as if the modal were still open, just hidden, with a taskbar chip to
  // bring it back (poll()/start()'s WindowManager.notify() calls flash that
  // chip -- and fire a real OS notification if permission was granted --
  // once it actually finishes or errors).
  function minimize() {
    const label = currentKind ? `template: ${currentKind}` : 'templates';
    WindowManager.minimize('templates', overlay, label);
  }

  openBtn.addEventListener('click', () => {
    if (WindowManager.isMinimized('templates')) WindowManager.restore('templates');
    else open();
  });
  closeBtn.addEventListener('click', close);
  minimizeBtn.addEventListener('click', minimize);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  WindowManager.makeDraggable(overlay.querySelector('.term-window'), overlay.querySelector('.term-titlebar'));
  form.addEventListener('submit', start);
  fileEl.addEventListener('change', () => diskSizeRow.classList.toggle('hidden', !isIsoSelected()));
  finalizeBtn.addEventListener('click', finalize);
  kindEl.addEventListener('change', checkVersionCollision);
  versionEl.addEventListener('input', checkVersionCollision);
})();
