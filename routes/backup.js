const express = require('express');
const settings = require('../lib/backup/settings');
const backup = require('../lib/backup/run');
const schedule = require('../lib/backup/schedule');
const { health } = require('../lib/backup/health');
const { clientIp } = require('../lib/client-ip');

// Settings -> Backup (lib/backup/). The access token is never returned.
//
//   GET  /api/backup            settings + last outcome + next scheduled run
//   GET  /api/backup/health     { warning } for the dashboard banner, or null
//   PUT  /api/backup/settings   save (partial; empty token keeps the saved one)
//   POST /api/backup/test       check repository access, writes nothing
//   POST /api/backup/run        back up now; answers when the commit is done
function view() {
  const s = settings.getSafe();
  const nextRun = schedule.next(settings.load());
  return {
    ...s,
    running: backup.isRunning(),
    nextRun: nextRun ? nextRun.toISOString() : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function buildBackupRoutes({ requireAuth }) {
  const router = express.Router();
  const fail = (res, err) => res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.message });

  router.get('/api/backup', requireAuth, (req, res) => res.json(view()));
  router.get('/api/backup/health', requireAuth, (req, res) => res.json({ warning: health(settings.load()) }));

  router.put('/api/backup/settings', requireAuth, (req, res) => {
    try {
      settings.save(req.body || {});
      res.json(view());
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/api/backup/test', requireAuth, async (req, res) => {
    try {
      res.json({ ok: true, ...(await backup.test()) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/backup/run', requireAuth, async (req, res) => {
    try {
      const last = await backup.run({ trigger: 'manual', user: req.session.username, ip: clientIp(req) });
      res.status(last.ok ? 200 : 502).json({ last, ...view() });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

module.exports = { buildBackupRoutes };
