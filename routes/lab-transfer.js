const express = require('express');
const transfer = require('../lib/lab-transfer');

// Lab export (a download), import (a new lab from a file's text) and
// duplicate (a clean copy of a lab as a new lab). For import the
// browser reads the chosen file itself and sends its text as JSON, so no
// multipart handling is needed; the 10 MB JSON limit in server.js is well
// above the 1 MB a lab file may be.
//
//   GET  /api/labs/:name/export[?clean=1]   -> <name>.lab.yml download
//   POST /api/labs/import { name, text }    -> { ok, name, warnings }
//   POST /api/labs/:name/duplicate { name } -> { ok, name } (a clean copy)
// A new lab whose name is taken -> 409; a lab that does not exist -> 404.
const statusOf = (err) => err.status || (/^Unknown lab file/.test(err.message) ? 404 : 400);

function buildLabTransferRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/api/labs/:name/export', requireAuth, (req, res) => {
    let out;
    try {
      out = transfer.exportLab(req.params.name, { clean: req.query.clean === '1' });
    } catch (err) {
      return res.status(statusOf(err)).json({ error: err.message });
    }
    res.attachment(out.filename);
    res.type('application/yaml').send(out.text);
  });

  router.post('/api/labs/import', requireAuth, (req, res) => {
    const { name, text } = req.body || {};
    try {
      res.json({ ok: true, ...transfer.importLab(name, text) });
    } catch (err) {
      res.status(statusOf(err)).json({ error: err.message });
    }
  });

  router.post('/api/labs/:name/duplicate', requireAuth, (req, res) => {
    try {
      res.json({ ok: true, ...transfer.duplicateLab(req.params.name, (req.body || {}).name) });
    } catch (err) {
      res.status(statusOf(err)).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildLabTransferRoutes };
