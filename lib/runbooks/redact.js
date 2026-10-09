// Replaces known secret values with *** in anything headed for a log, the
// run history, or the browser. Values are registered as they're resolved
// (see template.js's onResolve), so a secret is masked from the first
// moment it could possibly appear in output.

const MASK = '***';
const MIN_LENGTH = 4; // masking 1-3 char values would shred ordinary text

function createRedactor() {
  const secrets = new Set();
  return {
    // Also masks the URL-encoded and base64 forms, which is how a secret
    // looks once it has been placed in a query string or a shell one-liner.
    add(value) {
      if (typeof value !== 'string' || value.length < MIN_LENGTH) return;
      secrets.add(value);
      secrets.add(encodeURIComponent(value));
      secrets.add(Buffer.from(value, 'utf-8').toString('base64'));
    },
    apply(text) {
      let out = String(text);
      // longest first, so a secret containing another secret is masked whole
      for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join(MASK);
      return out;
    },
  };
}

module.exports = { createRedactor, MASK };
