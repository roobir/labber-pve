// Labs window: who last changed the open lab -- its latest few entries in the
// activity log (the lab and its nodes: saves, deploys, power, consoles...),
// with a link to the full list in Settings -> Activity. Refreshed when a lab
// is opened, saved, or an operation on it finishes (labs-editor.js).
(function () {
  const el = document.getElementById('labs-history');
  if (!el) return;

  const SHOWN = 3;
  const TIME_FORMAT = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  const LAB_VERBS = {
    'lab.create': 'created', 'lab.import': 'imported', 'lab.duplicate': 'created as a copy', 'lab.save': 'saved',
    'lab.deploy': 'deployed', 'lab.update': 'updated', 'lab.bootstrap': 'bootstrapped', 'lab.destroy': 'destroyed',
    'lab.reserve': 'reserved', 'lab.release': 'released',
  };
  let current = null; // the lab shown; a late answer for another lab is dropped

  // Creating a lab under a name that is taken fails without touching the
  // lab that has that name -- not part of its history.
  const CREATES = ['lab.create', 'lab.import', 'lab.duplicate'];

  // One entry as "saved by nico, 14 Oct 17:40" -- or null for entries that
  // say nothing new (an operation's "started" line, a console closing).
  function describe(e) {
    if (e.result === 'started' || e.action === 'console.close') return null;
    if (CREATES.includes(e.action) && e.result !== 'ok') return null;
    const node = e.target.split('/').slice(1).join('/');
    const nodeVerbs = {
      'console.open': `opened the console of ${node}`,
      'node.power': `${(e.detail && e.detail.action) || 'power'} ${node}`,
      'node.mgmt-ip': `set the mgmt IP of ${node}`,
      'node.identity': `changed the identity pins of ${node}`,
    };
    const what = LAB_VERBS[e.action] || (node && nodeVerbs[e.action]);
    if (!what) return null;
    const outcome = e.result === 'ok' ? '' : ` (${e.result})`;
    return `${what}${outcome} by ${e.user}, ${new Date(e.time).toLocaleString(undefined, TIME_FORMAT)}`;
  }

  function openActivity(lab) {
    document.getElementById('activity-q').value = lab;
    window.SettingsNav.open('activity');
  }

  function render(lab, entries) {
    const lines = entries.map(describe).filter(Boolean).slice(0, SHOWN);
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'banner-link';
    all.textContent = 'all activity';
    all.addEventListener('click', () => openActivity(lab));
    el.replaceChildren(lines.length ? `last changes: ${lines.join(' · ')}  ` : 'no recorded changes yet  ', all);
  }

  // show(labFile) loads and shows its history; show(null) clears the line.
  async function show(lab) {
    current = lab;
    el.replaceChildren();
    if (!lab) return;
    try {
      const res = await fetch(`/api/audit?target=${encodeURIComponent(lab)}&limit=50`);
      if (!res.ok) return;
      const { entries } = await res.json();
      if (current === lab) render(lab, entries);
    } catch (err) {
      // the history line is extra information; the editor works without it
    }
  }

  window.LabsHistory = { show };
})();
