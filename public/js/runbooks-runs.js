// Runs tab: recent runs (live and saved), newest first. Click one to watch
// it live or read its saved log.
(function () {
  const { h, api, say, show, fmtTime } = Runbooks;
  const REFRESH_MS = 5000;

  Runbooks.view('runs', (root) => {
    const tbody = h('tbody');
    root.append(h('table', { class: 'rb-table' },
      h('thead', {}, h('tr', {}, ['started', 'runbook', 'node', 'by', 'state', ''].map((t) => h('th', {}, t)))),
      tbody));

    function row(r) {
      return h('tr', { style: 'cursor:pointer', onclick: () => show('live', { runId: r.id }) },
        h('td', {}, fmtTime(r.startedAt)),
        h('td', {}, `${r.runbook} ${r.version}`),
        h('td', {}, r.target ? `${r.target.node}` : ''),
        h('td', {}, r.user),
        h('td', {}, h('span', { class: `rb-badge ${r.state}` }, r.state)),
        h('td', { class: 'dim' }, r.error || ''));
    }

    async function refresh() {
      try {
        const runs = await api('GET', '/api/runs');
        tbody.replaceChildren(...(runs.length ? runs.map(row) : [h('tr', {}, h('td', { colspan: 6, class: 'rb-empty' }, 'no runs yet'))]));
      } catch (err) {
        say(err.message, true);
      }
    }

    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  });
})();
