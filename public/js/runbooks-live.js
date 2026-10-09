// Live run view: step checklist, the node's serial console as it is being
// driven (read-only xterm), and a log. Attaches over /ws/runbook, which
// replays everything so far -- so opening this late, or after minimizing the
// window, shows the whole run. A run the server no longer holds in memory
// (e.g. after a restart) falls back to its saved log, without console output.
(function () {
  const { h, api, say, show } = Runbooks;
  const MARK = { pending: '·', running: '▶', ok: '✓', failed: '✗', skipped: '–' };

  Runbooks.view('live', (root, { runId }) => {
    const title = h('strong', {}, 'run');
    const badge = h('span', { class: 'rb-badge running' }, 'running');
    const abortBtn = h('button', { class: 'rb-btn danger', onclick: () => ws && ws.send(JSON.stringify({ type: 'abort', runId })) }, 'abort run');
    const steps = h('ul', { class: 'rb-steps' });
    const consoleBox = h('div', { class: 'rb-console hidden' });
    const log = h('div', { class: 'rb-log' });
    const stepEls = new Map();
    let term = null;
    let fit = null;
    let stopFit = null;
    let ws = null;

    function stepItem(id, name, state) {
      if (!stepEls.has(id)) {
        const li = h('li', {}, h('span', { class: 'rb-dot' }), h('span', {}, name || id));
        stepEls.set(id, li);
        steps.append(li);
      }
      const li = stepEls.get(id);
      li.className = state;
      li.firstChild.textContent = MARK[state];
    }

    function writeConsole(data) {
      if (!term) {
        consoleBox.classList.remove('hidden');
        term = new Terminal({ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, disableStdin: true, theme: { background: '#000000' } });
        fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        term.open(consoleBox);
        fit.fit();
        stopFit = TerminalFit.attach(fit, consoleBox);
      }
      term.write(data);
    }

    function finish(state, error) {
      badge.textContent = state;
      badge.className = `rb-badge ${state}`;
      abortBtn.disabled = true;
      if (error) log.append(h('div', { class: 'warn' }, `${state}: ${error}`));
    }

    function handle(e) {
      if (e.type === 'step') stepItem(e.id, e.name, e.state);
      else if (e.type === 'console') writeConsole(e.data);
      else if (e.type === 'done') finish(e.state, e.error);
      else if (e.type === 'log') {
        log.append(h('div', { class: e.level === 'warn' ? 'warn' : '' }, e.step ? h('span', { class: 'step' }, `[${e.step}] `) : null, e.line));
        log.scrollTop = log.scrollHeight;
      }
    }

    async function fallbackToSavedLog() {
      const rec = await api('GET', `/api/runs/${runId}`);
      rec.events.forEach(handle);
      finish(rec.state, rec.error);
    }

    root.append(
      h('div', { class: 'rb-toolbar' }, h('button', { class: 'rb-btn', onclick: () => show('runs') }, '← runs'), title, badge, abortBtn),
      h('div', { class: 'rb-live' }, steps, h('div', { class: 'rb-live-main' }, consoleBox, log))
    );

    api('GET', `/api/runs/${runId}`).then((r) => { title.textContent = `${r.runbook} ${r.version} -- ${r.user}`; }).catch(() => {});

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}/ws/runbook`);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'attach', runId })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'error') fallbackToSavedLog().catch((err) => say(err.message, true));
      else handle(msg);
    });

    return () => {
      if (ws) ws.close();
      if (stopFit) stopFit();
      if (term) term.dispose();
    };
  });
})();
