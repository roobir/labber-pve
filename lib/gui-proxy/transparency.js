// Generic "don't let the device notice the proxy" fixes, applied to every
// vendor by lib/gui-proxy.js: framing headers, cookies, redirects, Origin, and
// the error pages shown inside the embedded frame.

const STRIP_HEADERS = ['x-frame-options', 'content-security-policy', 'strict-transport-security'];

// Every device's session cookie is either SameSite=Strict (confirmed on F5
// and Palo Alto) or has no SameSite attribute at all, which Chrome then
// defaults to Lax (confirmed on Check Point) -- confirmed 2026-08-04.
// Both block a cookie from ever being sent back on a cross-site iframe
// subrequest, which every gui-proxy request is (this app's own origin is
// always a different site than any <lab>--<node>.<guiDomain> target). The
// login page itself still renders fine unauthenticated (no cookie needed
// yet), but the moment a user actually logs in through the embedded view,
// that session cookie can never travel back on the next framed request --
// looks like the app just breaks/goes blank right after login, for any
// vendor, not just F5. Rewriting SameSite to None (paired with Secure,
// which every one of these already sets, and which SameSite=None requires
// or browsers reject the cookie outright) is the standard fix for exactly
// this "embed a device's own admin UI inside a trusted internal tool"
// scenario -- deliberately loosens a CSRF-hardening default, same
// "trusted internal-only proxy" reasoning already applied to stripping
// X-Frame-Options above. Applied to every vendor unconditionally (unlike
// the F5-only body rewrite below), since the underlying browser cookie
// rule is identical regardless of which device is being proxied.
//
// A `Domain=` attribute is dropped too, making every cookie host-only: a
// device that scopes its cookie to its own name or IP (Domain=10.1.1.5)
// would otherwise have it rejected by the browser, which only accepts a
// Domain matching the page's host -- here <lab>--<node>.<guiDomain>.
// Host-only is also what keeps two proxied nodes' cookies apart.
const SAMESITE_RE = /;\s*SameSite=[^;]*/gi;
const DOMAIN_RE = /;\s*Domain=[^;]*/gi;
function forceSameSiteNone(cookie) {
  const stripped = cookie.replace(SAMESITE_RE, '').replace(DOMAIN_RE, '');
  const withSecure = /;\s*Secure\b/i.test(stripped) ? stripped : `${stripped}; Secure`;
  return `${withSecure}; SameSite=None`;
}

// The goal is that a device can't tell it is being proxied, and the browser
// never learns the device's real address. changeOrigin rewrites Host; these
// cover the other places a device's own origin shows up.

// A redirect to the device's own absolute URL (https://<mgmt-ip>/xui/...)
// would send the frame straight to the device, bypassing this proxy -- and
// fail outright for a browser that can't reach the management network.
// Rewritten to the same path relative to the current page, so the browser
// stays on <lab>--<node>.<guiDomain>. A redirect to any OTHER host (an SSO
// provider, say) is left alone.
function rewriteLocation(location, targetOrigin) {
  try {
    const loc = new URL(location);
    if (loc.hostname.toLowerCase() !== new URL(targetOrigin).hostname.toLowerCase()) return location;
    return `${loc.pathname}${loc.search}${loc.hash}`;
  } catch (err) {
    return location; // already relative (the common case), or unparsable
  }
}

// What a browser talking to the device directly would send as Origin. Devices
// that defend against CSRF compare Origin with their own Host (FortiOS, newer
// PAN-OS and F5 builds, many websocket endpoints) -- the proxy's hostname
// there would fail that check even though the Referer is already rewritten.
function setDeviceOrigin(proxyReq, req) {
  if (!req._targetOrigin || !req.headers.origin || req.headers.origin === 'null') return;
  try {
    proxyReq.setHeader('origin', new URL(req._targetOrigin).origin);
  } catch (err) {
    // headers already flushed on a reused socket (see the accept-encoding note below)
  }
}

// Shown inside the embedded frame, so it says what to check rather than
// just "502".
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function errorPage(res, status, title, lines) {
  if (!res || !res.writeHead || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font:14px/1.5 system-ui,sans-serif;background:#111;color:#ddd;padding:2rem">
<h2 style="margin:0 0 .6rem;color:#f5a524">${escapeHtml(title)}</h2>
<ul style="padding-left:1.2rem">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul></body>`);
}

module.exports = { STRIP_HEADERS, forceSameSiteNone, rewriteLocation, setDeviceOrigin, errorPage };
