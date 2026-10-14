const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file runs in its own process (node --test), so pointing LABS_DIR
// at a fresh temporary directory BEFORE requiring any lib/ module gives every
// file its own empty data volume. Audit lines on stdout are switched off.
function freshLabsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labber-test-'));
  process.env.LABS_DIR = dir;
  process.env.AUDIT_STDOUT = 'off';
  return dir;
}

module.exports = { freshLabsDir };
