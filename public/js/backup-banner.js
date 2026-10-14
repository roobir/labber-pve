// Dashboard banner when scheduled backups need attention: the last backup
// failed, or none has succeeded for too long (lib/backup/health.js decides;
// nothing is shown when backups are not set up or are manual-only). Checked
// on load and every 10 minutes -- backups run monthly or weekly, so there is
// nothing to gain from polling faster.
(function () {
  const banner = document.getElementById('backup-banner');
  if (!banner) return;

  const CHECK_MS = 10 * 60 * 1000;

  function render(warning) {
    banner.classList.toggle('hidden', !warning);
    banner.classList.toggle('warn', !!warning && warning.state === 'overdue');
    if (!warning) return;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'banner-link';
    open.textContent = 'open settings -> Backup';
    open.addEventListener('click', () => window.SettingsNav.open('backup'));
    banner.replaceChildren(`Backups: ${warning.message}. `, open);
  }

  async function check() {
    try {
      const res = await fetch('/api/backup/health');
      if (res.ok) render((await res.json()).warning);
    } catch (err) {
      // the next check tries again; a missing banner is not worth an error
    }
  }

  check();
  setInterval(() => { if (!document.hidden) check(); }, CHECK_MS);
  // Settings -> Backup announces a save or a finished backup (settings-backup.js).
  window.addEventListener('backup:changed', check);
})();
