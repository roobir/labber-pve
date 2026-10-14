// Settings -> Activity -> "most active": changes per user as horizontal
// stacked bars (labs / runbooks / consoles / other), for the last 7 days, the
// last 30 days, all time -- or all three, one under another. Data from
// /api/audit/summary (lib/audit/summary.js), loaded when the view is opened.
// Colours: the four dark-mode categorical slots, validated against the window
// background (dataviz validator: all checks pass, worst adjacent CVD 8.4);
// identity never rests on colour alone -- legend, numbers in the segments
// that fit, a tooltip per segment, and a table view.
(function () {
  const button = document.getElementById('activity-chart-btn');
  const root = document.getElementById('activity-chart');
  if (!button || !root) return;

  const KINDS = [
    { key: 'labs', label: 'labs', color: '#3987e5', ink: '#000' },
    { key: 'runbooks', label: 'runbooks', color: '#d95926', ink: '#000' },
    { key: 'consoles', label: 'consoles', color: '#199e70', ink: '#000' },
    { key: 'other', label: 'other changes', color: '#c98500', ink: '#000' },
  ];
  const PERIODS = [['week', 'last 7 days'], ['month', 'last 30 days'], ['all', 'all time']];
  const SHOWN = 10; // users per chart; the rest are summed in one line
  const MIN_LABEL_PX = 26; // a segment narrower than this keeps its number in the tooltip

  let data = null;
  let view = 'week'; // a period key, or 'compare'
  let asTable = false;
  const tooltip = el('div', 'chart-tooltip hidden');

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showTip(e, text) {
    tooltip.textContent = text;
    tooltip.classList.remove('hidden');
    const box = root.getBoundingClientRect();
    tooltip.style.left = `${Math.min(e.clientX - box.left + 12, box.width - 180)}px`;
    tooltip.style.top = `${e.clientY - box.top + 14}px`;
  }

  function bar(row, max) {
    const track = el('div', 'chart-track');
    const stack = el('div', 'chart-stack');
    stack.style.width = `${(row.total / max) * 100}%`;
    for (const k of KINDS) {
      const n = row.kinds[k.key];
      if (!n) continue;
      const seg = el('div', 'chart-seg');
      Object.assign(seg.style, { flexGrow: String(n), background: k.color, color: k.ink });
      const text = `${row.user} -- ${k.label}: ${n} of ${row.total} (${Math.round((n / row.total) * 100)}%)`;
      seg.setAttribute('aria-label', text);
      seg.addEventListener('mousemove', (e) => showTip(e, text));
      seg.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
      stack.append(seg);
      // the number goes inside only once the segment's real width is known
      requestAnimationFrame(() => { if (seg.getBoundingClientRect().width >= MIN_LABEL_PX) seg.textContent = n; });
    }
    const lane = el('div', 'chart-lane'); // the bar's share of the width; the total sits after it
    lane.append(stack);
    track.append(lane, el('span', 'chart-total', String(row.total)));
    return track;
  }

  function chart(period, title) {
    const rows = data.periods[period];
    const box = el('div', 'chart-panel');
    if (title) box.append(el('div', 'chart-title', title));
    if (!rows.length) {
      box.append(el('div', 'users-list-empty', 'no changes recorded in this period'));
      return box;
    }
    const max = rows[0].total;
    for (const row of rows.slice(0, SHOWN)) {
      const line = el('div', 'chart-row');
      line.append(el('span', 'chart-user', row.user), bar(row, max));
      box.append(line);
    }
    const rest = rows.slice(SHOWN);
    if (rest.length) box.append(el('div', 'chart-more', `+ ${rest.length} more (${rest.reduce((n, r) => n + r.total, 0)} changes) -- see the table`));
    return box;
  }

  function table(period, title) {
    const t = el('table', 'activity-table');
    const head = el('tr');
    for (const h of ['user', ...KINDS.map((k) => k.label), 'total']) head.append(el('th', null, h));
    t.append(el('thead'), el('tbody'));
    t.tHead.append(head);
    for (const row of data.periods[period]) {
      const tr = el('tr');
      tr.append(el('td', null, row.user), ...KINDS.map((k) => el('td', null, String(row.kinds[k.key]))), el('td', null, String(row.total)));
      t.tBodies[0].append(tr);
    }
    const box = el('div', 'chart-panel');
    box.append(el('div', 'chart-title', title || ''), data.periods[period].length ? t : el('div', 'users-list-empty', 'no changes recorded in this period'));
    return box;
  }

  function legend() {
    const box = el('div', 'chart-legend');
    for (const k of KINDS) {
      const item = el('span', 'chart-key');
      const swatch = el('span', 'chart-swatch');
      swatch.style.background = k.color;
      item.append(swatch, k.label);
      box.append(item);
    }
    return box;
  }

  function controls() {
    const box = el('div', 'chart-controls');
    for (const [key, label] of [...PERIODS, ['compare', 'all three']]) {
      const b = el('button', key === view ? 'active' : '', label);
      b.type = 'button';
      b.addEventListener('click', () => { view = key; render(); });
      box.append(b);
    }
    const t = el('button', `chart-as-table${asTable ? ' active' : ''}`, asTable ? 'show chart' : 'show table');
    t.type = 'button';
    t.addEventListener('click', () => { asTable = !asTable; render(); });
    box.append(t);
    return box;
  }

  function render() {
    tooltip.classList.add('hidden');
    const draw = asTable ? table : chart;
    const panels = view === 'compare' ? PERIODS.map(([p, label]) => draw(p, label)) : [draw(view, null)];
    const body = el('div', view === 'compare' ? 'chart-compare' : '');
    body.append(...panels);
    const note = el('div', 'dim chart-note', `Changes made, per user (sign-ins not counted). All time = the ${data.retentionDays} days the activity log keeps.`);
    root.replaceChildren(controls(), asTable ? '' : legend(), body, note, tooltip);
  }

  async function open() {
    root.replaceChildren(el('div', 'dim', 'loading…'));
    try {
      const res = await fetch('/api/audit/summary');
      if (!res.ok) throw new Error(`could not load the summary (${res.status})`);
      data = await res.json();
      render();
    } catch (err) {
      root.replaceChildren(el('div', 'labs-message', err.message));
    }
  }

  button.addEventListener('click', () => {
    const hidden = root.classList.toggle('hidden');
    button.classList.toggle('active', !hidden);
    if (!hidden) open();
  });
  // Coming back to the Activity panel with the chart still open: fresh numbers.
  document.querySelector('#settings-nav [data-panel="activity"]').addEventListener('click', () => {
    if (!root.classList.contains('hidden')) open();
  });
})();
