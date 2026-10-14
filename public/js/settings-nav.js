// Left-nav panel switcher for the settings modal -- purely a visibility
// toggle, no knowledge of what any panel actually contains. Elements with
// `data-panel-group="a b c"` (e.g. the connection form's shared save/test
// action bar, spanning several panels that are really one underlying
// <form>) show whenever the active panel is any of the listed names, not
// just an exact match.
(function () {
  const nav = document.getElementById('settings-nav');
  if (!nav) return;

  const navItems = nav.querySelectorAll('.settings-nav-item');
  const panels = document.querySelectorAll('#settings-overlay .settings-panel');
  const groupEls = document.querySelectorAll('#settings-overlay [data-panel-group]');

  function show(name) {
    for (const item of navItems) item.classList.toggle('active', item.dataset.panel === name);
    for (const panel of panels) panel.classList.toggle('hidden', panel.dataset.panel !== name);
    for (const el of groupEls) {
      el.classList.toggle('hidden', !el.dataset.panelGroup.split(' ').includes(name));
    }
  }

  for (const item of navItems) {
    item.addEventListener('click', () => show(item.dataset.panel));
  }

  // Opens the settings window on `name`. Clicking the panel's nav item (not
  // just show()) also runs whatever that panel loads when it is opened --
  // the Activity and Backup panels fetch their data on that click.
  function open(name) {
    document.getElementById('settings-btn').click();
    const item = nav.querySelector(`.settings-nav-item[data-panel="${name}"]`);
    if (item) item.click();
  }

  window.SettingsNav = { show, open };
})();
