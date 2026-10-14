// Settings -> Activity: the audit log (lib/audit/), newest first, with
// filters, "show more" paging and a CSV export of the same filtered view.
// Loads when the panel is opened, never in the background. Every value is
// set with textContent -- lab, node and user names are user-chosen text.
(function () {
  const navItem = document.querySelector('#settings-nav [data-panel="activity"]');
  const form = document.getElementById('activity-filters');
  if (!navItem || !form) return;

  const listEl = document.getElementById('activity-list');
  const moreBtn = document.getElementById('activity-more');
  const messageEl = document.getElementById('activity-message');
  const csvLink = document.getElementById('activity-csv');
  const usersList = document.getElementById('activity-users');
  const retentionEl = document.getElementById('activity-retention');
  const field = (id) => document.getElementById(id).value.trim();

  const PAGE = 200;
  // Short enough to keep the table inside the panel; hover shows it in full.
  const TIME_FORMAT = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  let limit = PAGE;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setMessage(text, isError) {
    messageEl.textContent = text || '';
    messageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  // The date pickers mean local days; the log is kept in UTC.
  function query() {
    const params = new URLSearchParams();
    const from = field('activity-from');
    const to = field('activity-to');
    if (field('activity-q')) params.set('q', field('activity-q'));
    if (field('activity-user')) params.set('user', field('activity-user'));
    if (field('activity-action')) params.set('action', field('activity-action'));
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
    return params;
  }

  const detailText = (detail) => Object.entries(detail || {}).map(([k, v]) => `${k}=${v}`).join('  ');

  function row(entry) {
    const tr = el('tr');
    const at = new Date(entry.time);
    const time = el('td', 'activity-time', at.toLocaleString(undefined, TIME_FORMAT));
    time.title = at.toString();
    tr.append(
      time,
      el('td', 'activity-user', entry.user),
      el('td', 'activity-action', entry.action),
      el('td', null, entry.target),
      el('td', null, '')
    );
    tr.lastChild.append(el('span', `activity-result ${entry.result}`, entry.result));
    tr.children[1].append(el('div', 'dim activity-ip', entry.ip)); // where from, under who
    tr.append(el('td', 'dim', detailText(entry.detail)));
    return tr;
  }

  function render(entries) {
    if (!entries.length) {
      listEl.replaceChildren(el('div', 'users-list-empty', 'nothing recorded for this view'));
      return;
    }
    const table = el('table', 'activity-table');
    const head = el('tr');
    for (const label of ['time', 'user / from', 'action', 'target', 'result', 'detail']) head.append(el('th', null, label));
    table.append(el('thead'), el('tbody'));
    table.tHead.append(head);
    for (const entry of entries) table.tBodies[0].append(row(entry));
    listEl.replaceChildren(table);
  }

  async function load() {
    const params = query();
    csvLink.href = `/api/audit.csv?${params}`;
    params.set('limit', String(limit));
    setMessage('loading…');
    try {
      const res = await fetch(`/api/audit?${params}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'could not load the activity log');
      render(body.entries);
      moreBtn.classList.toggle('hidden', body.entries.length < limit);
      retentionEl.textContent = `Kept for ${body.retentionDays} days.`;
      setMessage('');
    } catch (err) {
      setMessage(err.message, true);
    }
  }

  async function loadUsers() {
    try {
      const res = await fetch('/api/users');
      if (!res.ok) return;
      usersList.replaceChildren(...(await res.json()).map(({ username }) => Object.assign(el('option'), { value: username })));
    } catch (err) {
      // only a typing aid -- the filter works without it
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    limit = PAGE;
    load();
  });
  moreBtn.addEventListener('click', () => {
    limit += PAGE;
    load();
  });
  navItem.addEventListener('click', () => {
    limit = PAGE;
    loadUsers();
    load();
  });
})();
