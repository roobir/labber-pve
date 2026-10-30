const test = require('node:test');
const assert = require('node:assert');
const { rewriteBody } = require('../lib/gui-proxy/vendor-rewrites');

// F5's /tmui/redirect.jsp decision, as rewritten by the web rp proxy. Runs the
// rewritten script with a fake window/parent and reports where it navigated.
const REDIRECT_JSP = 'if (window == top || !window.parent.Xui) { go("xui"); } else { go("welcome"); }';

function whereTo(parent) {
  const script = rewriteBody(REDIRECT_JSP);
  let target = null;
  new Function('window', 'top', 'go', script)({ parent }, {}, (t) => { target = t; });
  return target;
}

test('F5 redirect.jsp framed by the labber dashboard (after login) goes to /xui/', () => {
  const dashboard = {};
  Object.defineProperty(dashboard, 'Xui', { get() { throw new Error('SecurityError: cross-origin frame'); } });
  assert.strictEqual(whereTo(dashboard), 'xui');
});

test('F5 redirect.jsp as the /xui/ shell contentframe (home page) goes to the welcome page, not a nested shell', () => {
  assert.strictEqual(whereTo({ Xui: {} }), 'welcome');
});

test('the F5 redirect rewrite leaves pages without that snippet alone', () => {
  const other = '<script>if (self == top) { init(); }</script>';
  assert.strictEqual(rewriteBody(other), other);
});
