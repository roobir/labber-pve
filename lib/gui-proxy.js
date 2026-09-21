// Second HTTP listener (separate port from the main Express app) that
// reverse-proxies a running lab node's real web UI, reached via a
// Host-header-routed subdomain: <labName>--<nodeName>.<guiDomain>. This is
// what lets the dashboard embed a node's GUI in an <iframe> instead of only
// opening it in a new tab -- vendor web UIs commonly send
// `X-Frame-Options: DENY`/a frame-ancestors CSP (confirmed on Palo Alto
// Panorama in the old libvirt-based labber project this was ported from,
// see ~/claude/labber/dashboard/lib/gui-proxy/), which a raw TCP/L4 proxy
// has no way to touch since it never parses HTTP; terminating HTTP here
// and stripping those headers is what actually makes the embedded view
// work.
//
// Plain HTTP, not HTTPS, despite every node target being reached over
// HTTPS: whatever fronts this listener (npmplus, a k8s Ingress) already
// terminates real TLS on the way in from browsers, and that hop stays on
// the trusted internal network. The outbound leg to each device is still
// HTTPS regardless (set by the `target` URL built below), independent of
// how this listener itself receives connections.
//
// Off by default: resolveTarget() 404s on every request until config-store's
// guiDomain is set from the Settings page -- requires a wildcard DNS record
// plus a reverse-proxy/Ingress rule for `*.<guiDomain>` pointing at
// GUI_PROXY_PORT, set up outside this app (see README). The listener itself
// always starts regardless, same "off means every request 404s, not that
// the route doesn't exist" pattern as the public stats API
// (lib/public-routes.js) -- simpler than making the k8s/Ingress config
// conditional on whether the Settings field happens to be filled in yet.
const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const configStore = require('./config-store');
const labManager = require('./lab-manager');

const GUI_PROXY_PORT = parseInt(process.env.GUI_PROXY_PORT, 10) || 8081;
const DEFAULT_TARGET_PORT = 443;

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
const SAMESITE_RE = /;\s*SameSite=[^;]*/gi;
function forceSameSiteNone(cookie) {
  const stripped = cookie.replace(SAMESITE_RE, '');
  const withSecure = /;\s*Secure\b/i.test(stripped) ? stripped : `${stripped}; Secure`;
  return `${withSecure}; SameSite=None`;
}

// F5 BIG-IP's TMUI ships a static frame-busting check on its HTML pages --
// confirmed 2026-08-04 by reading the actual login.jsp source, not
// configurable via any BIG-IP sys db/tmsh setting:
//   if (window.location != window.top.location) {
//       window.top.location = window.location;
//   }
// Blocking that write via the dashboard iframe's sandbox attribute (see
// public/index.html) stops it from hijacking the whole tab, but the
// assignment throws when blocked -- which aborts the rest of that inline
// <script> block before it ever reaches the *separate*
// `window.onload = ...` statement further down the same block, and it's
// that onload handler that actually populates the real login form into a
// nested iframe. Net effect: successfully blocking the hijack silently
// breaks the login form too, as a side effect, not a separate failure.
// Since there's no BIG-IP-side setting for this, stripping just this one
// known snippet (see the proxyRes handler below) is the only way to get a
// working embedded F5 login -- deliberately a literal, narrow match (not
// a generic "delete anything mentioning frames" regex) so nothing else on
// any page, F5's or otherwise, is ever touched.
const F5_FRAMEBUST_RE = /if\s*\(\s*window\.location\s*!=\s*window\.top\.location\s*\)\s*\{\s*window\.top\.location\s*=\s*window\.location\s*;\s*\}/;

// A second, separate F5 script -- confirmed 2026-09-20 by reading the real
// /tmui/redirect.jsp source (the page BIG-IP's login POST redirects to on
// success): `if (window == top || !window.parent.Xui) { ...navigate this
// frame to /xui/... } else { ...navigate to the welcome page... }`. Reading
// `window.parent.Xui` cross-origin (our dashboard is never a real BIG-IP
// Xui wrapper) throws a SecurityError synchronously, before either branch's
// navigation ever runs -- an uncaught exception that leaves the frame
// permanently blank right after an otherwise-successful login, not a
// deliberate hijack attempt like F5_FRAMEBUST_RE above. Forcing the
// condition to always-true keeps it on the branch that already does the
// right thing for an embedded view (navigate *this* frame to /xui/, never
// window.top), without ever touching window.parent.
const F5_REDIRECT_XUI_CHECK_RE = /window\s*==\s*top\s*\|\|\s*!window\.parent\.Xui/;

// PAN-OS (confirmed on paloalto_panos, 2026-09-20 -- Panorama shares the same
// web framework so it's included too, not yet independently confirmed)
// ships its own tiny inline anti-clickjacking frame-buster on every page,
// read directly out of the live page's first <script> tag:
//   if (self != top) {
//       top.location = self.location;
//   }
// Same root cause as F5_FRAMEBUST_RE above -- our iframe's sandbox
// deliberately omits allow-top-navigation, so the cross-origin assignment
// throws (`SecurityError: Failed to set a named property 'href' on
// 'Location'`) instead of silently no-op-ing, and since this is the very
// first script PAN-OS runs, the uncaught throw stops all page init dead
// before anything renders -- confirmed live as a permanently blank white
// web-rp iframe. Unlike F5's login.jsp, this snippet does nothing else
// (no onload handler sharing the same inline block), so stripping it
// outright is safe -- no follow-up "neutralize instead of remove" needed
// the way F5_REDIRECT_XUI_CHECK_RE was.
const PANOS_FRAMEBUST_RE = /if\s*\(\s*self\s*!=\s*top\s*\)\s*\{\s*top\.location\s*=\s*self\.location\s*;\s*\}/;

// A second, separate PAN-OS frame-buster template -- confirmed 2026-09-21
// by fetching /php/login.php directly (the login page has its own inline
// script, distinct from the main app page's PANOS_FRAMEBUST_RE above, so
// that fix alone didn't cover it):
//   if (self == top) {
//       document.documentElement.style.display = 'block';
//   } else {
//       top.location = self.location;
//   }
// The page's <html> starts hidden (display:none) and this is what reveals
// it -- unlike PANOS_FRAMEBUST_RE's snippet, simply stripping the whole
// thing would leave the page permanently blank (the reveal line would
// never run). Same "neutralize instead of remove" reasoning as
// F5_REDIRECT_XUI_CHECK_RE: keep the needed if-branch behavior (reveal),
// drop only the crashing else-branch (cross-origin top-navigation).
const PANOS_LOGIN_FRAMEBUST_RE = /if\s*\(\s*self\s*==\s*top\s*\)\s*\{\s*document\.documentElement\.style\.display\s*=\s*'block'\s*;\s*\}\s*else\s*\{\s*top\.location\s*=\s*self\.location\s*;\s*\}/;

// Three more PAN-OS bugs, all in the *JavaScript bundle* rather than the
// HTML page (confirmed 2026-09-20 by fetching panos-fw-01's actual
// panos-panos-firewall-main.js and grepping it -- each pattern below is
// verified unique across the whole ~11MB bundle before being treated as
// safe to blind-replace): its bundled Ext.History module (Sencha ExtJS's
// old hash-routing helper, used here for the SPA's back/forward + deep-
// linking support) assumes it always runs at the top of the window and
// never guards any of this against a cross-origin top:
//   - getHash() does `top.location.href` to read the current hash --
//     this exact read is the original bug reported via F12 (`Failed to
//     read a named property 'href' from 'Location'`), thrown from
//     startUp() on init, before PANOS_FRAMEBUST_RE above was fixed this
//     was never reached; confirmed still present once that first bug's
//     fix lets init proceed this far.
//   - History.add() does `top.location.hash = token` on every SPA nav
//     (e.g. clicking ACC/MONITOR/POLICIES) -- setting any Location
//     property other than href cross-origin is blocked outright (unlike
//     href, which cross-origin code may only *write*, never read), so
//     this would throw the moment the embedded user clicked any top-nav
//     tab, even after the getHash() fix. Same literal text appears twice
//     (a second, dead-in-any-modern-browser copy lives in the IE6/7-only
//     checkIFrame() fallback) -- replaced globally rather than picking
//     one, since both are the identical fix.
//   - redirect.js's redirect() does `window.top.location.assign(...)`,
//     used for session-expiry/logout-style full navigations -- same
//     cross-origin-write problem, and even if it didn't throw we don't
//     want a vendor page yanking the whole browser tab away from this
//     app's own dashboard (the same reasoning F5_FRAMEBUST_RE above
//     already applies).
// All three read/write `top` where the code actually only needs "this
// frame" -- rewriting top -> self keeps every one of these features
// (hash-based deep-linking, tab navigation, session-expiry redirects)
// working exactly as before, just scoped to the embedded frame instead of
// reaching for (and crashing on) our real top window.
const PANOS_HISTORY_HREF_RE = /top\.location\.href/;
const PANOS_HISTORY_HASH_RE = /top\.location\.hash = token;/g;
const PANOS_REDIRECT_ASSIGN_RE = /window\.top\.location\.assign/;

// Vendor kinds whose responses need any of the string-replace rewrites
// above -- drives both the selfHandleResponse opt-in below and which
// regexes proxyRes applies. Despite the name (kept from before PAN-OS's
// bugs turned out to live in its JS bundle rather than its HTML), this
// now also gates the JS-bundle rewrite in proxyRes below.
const HTML_REWRITE_KINDS = new Set(['f5_bigip_ve', 'paloalto_panos', 'paloalto_panorama']);

// Without a dedicated agent here, node-http-proxy falls back to Node's
// default (no-keepalive) https.Agent, opening a brand-new TCP+TLS handshake
// to the node's own mgmt IP for *every single proxied request* -- including
// every one of the dozens of parallel chunk-file requests a heavy vendor
// GUI's SPA can fire on one page load (confirmed: a FortiOS admin GUI's
// login page alone fires 100+). A small embedded appliance's web server
// can plausibly refuse/reset some fraction of that many simultaneous fresh
// handshakes even though it serves ongoing traffic fine -- reusing a small
// pool of persistent connections per backend host:port avoids hammering it
// this way. rejectUnauthorized stays false, matching `secure: false` below
// (self-signed certs are the norm for vendor appliance mgmt UIs).
//
// maxSockets lowered 20 -> 6, confirmed 2026-09-21 as the actual root cause
// of PAN-OS's web-rp white screen (paloalto_panos, panos-fw-01): every real
// page load fires ~35 concurrent asset requests, and /php/predefined.php
// (one of the heavier ones -- it's what PanPredefinedCache.initCache()
// needs) came back 503 on *every single* proxied load, while every other
// asset succeeded. A/B'd against the same login on the node's real mgmt IP
// directly (bypassing this proxy entirely) with the identical browser and
// session -- predefined.php was 200 there, page rendered fully, no
// concurrency-related failures at all. Confirmed it wasn't a one-off: an
// isolated (non-concurrent) fetch of predefined.php through this same
// proxy also succeeded every time, so the failure is specifically tied to
// this proxy holding open up to `maxSockets` fresh backend connections at
// once, not to the endpoint or the device being slow in general. A real
// browser going direct never opens more than ~6 connections to one origin
// on HTTP/1.1 (or multiplexes over one HTTP/2 connection); this proxy's
// pool of up to 20 distinct backend connections is what's different, and
// 503 is the classic shape of a backend hitting its own worker/connection
// limit. 6 matches what direct access (proven reliable above) actually
// does. Only verified on PAN-OS -- if F5 (the reason 20 was chosen
// originally) regresses, that'd mean BIG-IP's mgmt httpd tolerates more
// concurrent connections than PAN-OS's does, and this may need to become
// a per-vendor value instead of one shared constant.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 6, rejectUnauthorized: false });

const proxy = httpProxy.createProxyServer({ secure: false, changeOrigin: true, agent: keepAliveAgent });

// Root-caused 2026-09-21: the *real* reason PAN-OS's web-rp kept white-
// screening even after the maxSockets fix above. This whole rewrite path
// buffers a response fully into memory, converts it to a JS string, and
// runs several regex .replace() calls across it -- fine for small HTML
// pages, but panos-panos-firewall-main.js alone is ~10.7MB, and this was
// redone from scratch on *every single request* for it, synchronously, on
// gui-proxy's one Node event loop (which also serves the main dashboard
// app on port 8080 -- same process). A real page load fires several of
// these large rewrites back-to-back-to-concurrently; while one is running,
// Node cannot accept or service any other connection on either port,
// including /php/predefined.php's request landing at the same moment.
// Confirmed via `kubectl logs` showing *zero* trace of the failing
// requests (not even our own proxy.on('error') line) -- they were still
// sitting in the OS accept queue, never reaching Express/http-proxy at
// all, when HAProxy's own client-side wait gave up and returned its stock
// 502 page (`<html><body><h1>502 Bad Gateway</h1>...`, confirmed by
// fetching a failing response's body directly -- that's HAProxy's error
// page, not ours or PAN-OS's).
//
// These asset URLs already carry the vendor's own cache-busting query
// param (`?__version=<build id>`), which only changes when the
// underlying file actually does -- the same immutable-asset convention
// webpack content-hashing uses. That makes it safe to cache the fully
// rewritten response *once* per URL and serve it from memory on every
// later request, skipping both the backend round-trip and the expensive
// regex work entirely. Deliberately gated on the URL containing
// `__version=` (checked at both read and write sites below) rather than
// caching every rewritten response: a page like /php/login.php has no
// such param and can carry session-specific content (e.g. a per-session
// token) -- caching that indiscriminately could leak one session's page
// into another's. Static, version-stamped bundles carry no such risk.
// Unbounded Map, no eviction: the realistic key space here is small (this
// homelab's handful of vendor GUIs times however many firmware versions
// are actually in use at once), not worth the complexity of an LRU.
const rewriteCache = new Map();

// Only set when the request targets an F5 node (see the server's request
// handler below) -- string-replacing the response body reliably needs the
// backend to not compress it, rather than this proxy having to gunzip/
// brotli-decode first just to do a literal find-and-replace.
proxy.on('proxyReq', (proxyReq, req) => {
  if (req._htmlRewrite) {
    try {
      proxyReq.removeHeader('accept-encoding');
    } catch (err) {
      // Root-caused 2026-09-21: this throws ERR_HTTP_HEADERS_SENT when
      // proxyReq's headers are already flushed by the time this handler
      // runs -- a real, apparently long-latent race on a *reused*
      // keep-alive socket (confirmed via a real crash: node-http-proxy
      // emits 'proxyReq' synchronously as part of its own request-pipe
      // setup, and under load a socket handed back from the pool can
      // already be mid-flight). This is a plain EventEmitter 'proxyReq'
      // listener, not a request/response handler -- Node has no built-in
      // safety net for an exception thrown here, so it was propagating
      // all the way up to an *uncaught exception that killed the entire
      // process* (both ports, every lab, every user -- confirmed via a
      // real crash-loop, `kubectl describe pod` showing repeated
      // BackOff/restarts). Lowering maxSockets 20 -> 6 (previous commit)
      // made socket reuse far more frequent, which is almost certainly
      // why this pre-existing-but-rare race suddenly became frequent
      // enough to crash-loop the whole app. Failing to strip the header
      // here just means this one response comes back compressed and
      // this rewrite has to be skipped for it (see the content-encoding
      // check this makes necessary in proxyRes) -- annoying, never fatal.
    }
  }

  // F5 BIG-IP's login endpoint (Apache's f5_auth_cookie module) refuses to
  // authenticate a request whose Referer doesn't match its own hostname --
  // confirmed by reading f5-kvm-01's own /var/log/secure during a real
  // failed login: "Login is not permitted without a valid referer header or
  // forwarded header when sys db variable systemauth.permitloginwithoutheaders
  // is disabled." changeOrigin (above) already rewrites the outbound Host to
  // the device's own IP for routing; rewriting Referer's origin to match
  // makes it consistent with that Host, satisfying the same check a normal
  // direct (non-proxied) visit would.
  //
  // Tried X-Forwarded-Host first (the other half of that log message, and
  // the more conventional reverse-proxy fix) -- that got past the login
  // POST, but broke everything *after* it: BIG-IP's mcpd started rejecting
  // every subsequent authenticated request (the dashboard's own polling)
  // as a login attempt by a bogus user literally named "%tmui" ("User login
  // disallowed: ... has not been assigned a role on a partition"),
  // confirmed via /var/log/ltm. Presence of X-Forwarded-Host evidently
  // activates a *different* BIG-IP host-header-based user/partition mapping
  // path that has nothing to do with the CSRF check we're trying to
  // satisfy. Referer rewriting alone avoids that path entirely while still
  // fixing the login rejection.
  if (req.headers.referer && req._targetOrigin) {
    try {
      const referer = new URL(req.headers.referer);
      const target = new URL(req._targetOrigin);
      referer.protocol = target.protocol;
      referer.host = target.host;
      proxyReq.setHeader('referer', referer.toString());
    } catch (err) {
      // Unparsable Referer -- leave it untouched rather than fail the request.
    }
  }
});

proxy.on('proxyRes', (proxyRes, req, res) => {
  for (const header of STRIP_HEADERS) delete proxyRes.headers[header];
  if (proxyRes.headers['set-cookie']) {
    // Node represents repeated headers (Set-Cookie can appear multiple
    // times in one response) as an array -- [].concat() normalizes the
    // single-string case too, so this works either way.
    proxyRes.headers['set-cookie'] = [].concat(proxyRes.headers['set-cookie']).map(forceSameSiteNone);
  }

  // Every other request (i.e. any node whose kind isn't in
  // HTML_REWRITE_KINDS, and those vendors' own non-HTML assets -- see
  // below) never sets selfHandleResponse, so node-http-proxy auto-pipes
  // proxyRes -> res on its own once this handler returns; only a request
  // flagged for rewriting needs anything past the header-stripping above.
  if (!req._htmlRewrite) return;

  const contentType = proxyRes.headers['content-type'] || '';
  // PAN-OS's bugs live in its JS bundle (panos-panos-<product>-main.js),
  // not just its HTML -- unlike F5, where every known fix is HTML-only.
  // Originally gated this on content-type containing "javascript" at all,
  // which seemed reasonable but was wrong: confirmed via server-side
  // logging (2026-09-21) that /php/predefined.php -- a dynamically
  // generated *.js-shaped endpoint carrying threat/app-signature data,
  // nothing our regexes could ever match -- also declares a JS content-
  // type, so every request to it was being needlessly buffered, string-
  // converted, and run through all 7 regex passes: 6.2MB of pure waste on
  // every single load, and never cached (it has no __version= param).
  // That's a real, measurable chunk of the same event-loop-blocking
  // problem the rewriteCache fix (previous commits) only partly
  // addressed. Match the known bundle filename pattern instead of a loose
  // content-type substring -- narrower, but this is the only JS file any
  // confirmed bug actually lives in.
  //
  // Originally matched only "panos-panos-firewall-main.js" (paloalto_panos)
  // -- confirmed 2026-09-21 that paloalto_panorama's equivalent file is
  // named panos-panos-panorama-main.js instead (same vendored ExtJS
  // Ext.History module, same 4 unfixed top.location occurrences, verified
  // via a real fetch), so that narrow match silently left every one of
  // these bugs live for Panorama specifically. Generalized to match any
  // "panos-panos-<product>-main.js" rather than hardcoding a second literal
  // name, since a third PAN-OS product variant (e.g. a future GlobalProtect
  // portal bundle) would otherwise hit this exact same gap again.
  const isPanosMainBundle = /panos-panos-[\w-]+-main\.js/i.test(req.url);
  if (!/text\/html/i.test(contentType) && !isPanosMainBundle) {
    // Neither HTML nor the one known JS bundle -- nothing to rewrite.
    // selfHandleResponse disabled node-http-proxy's automatic piping for
    // this whole request, so this replicates exactly what it would have
    // done on its own.
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }

  // proxyReq's accept-encoding strip can fail (see its own comment) and
  // leave this response genuinely compressed. Treating a gzip/br/deflate
  // buffer as UTF-8 text would silently mangle it -- the regexes below
  // just wouldn't match (harmless), but writing the corrupted bytes back
  // out under the original (still-compressed) Content-Encoding header
  // would leave the browser trying to decode garbage
  // (ERR_CONTENT_DECODING_FAILED). Bail out to a plain untouched pipe in
  // that case, same as the non-rewritable-content-type branch above --
  // missing this one rewrite on a rare race is fine, corrupting the
  // response is not.
  if (proxyRes.headers['content-encoding']) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }

  const chunks = [];
  proxyRes.on('data', (chunk) => chunks.push(chunk));
  proxyRes.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    // Every regex below is a narrow, literal match against one specific
    // known vendor snippet -- harmless to run against every rewritten
    // vendor's response even when that particular snippet doesn't apply,
    // since none of them match anything on a different vendor's pages (or
    // on the wrong content type -- e.g. the PAN-OS JS-bundle patterns
    // never match real HTML, and vice versa).
    const rewritten = body
      .replace(F5_FRAMEBUST_RE, '')
      .replace(F5_REDIRECT_XUI_CHECK_RE, 'true')
      .replace(PANOS_FRAMEBUST_RE, '')
      .replace(PANOS_LOGIN_FRAMEBUST_RE, "document.documentElement.style.display = 'block';")
      .replace(PANOS_HISTORY_HREF_RE, 'self.location.href')
      .replace(PANOS_HISTORY_HASH_RE, 'self.location.hash = token;')
      .replace(PANOS_REDIRECT_ASSIGN_RE, 'window.self.location.assign');
    const outBuf = Buffer.from(rewritten, 'utf8');
    const outHeaders = { ...proxyRes.headers, 'content-length': outBuf.length };

    if (req.method === 'GET' && proxyRes.statusCode === 200 && req._cacheKey) {
      rewriteCache.set(req._cacheKey, { statusCode: proxyRes.statusCode, headers: outHeaders, body: outBuf });
    }

    res.writeHead(proxyRes.statusCode, outHeaders);
    res.end(outBuf);
  });
});

// Logged server-side (not just written into the HTTP response body, which
// is all this handler used to do) -- a failure here previously left zero
// trace in `kubectl logs`, only a "GUI proxy error: ..." string in whatever
// browser tab/iframe happened to be open at the time. err.code (e.g.
// ECONNREFUSED/ECONNRESET/ETIMEDOUT) is the useful part for telling a
// routing misconfiguration (nothing listening at all) apart from a
// mid-session drop (something reset an established connection).
proxy.on('error', (err, req, res) => {
  console.error(`gui-proxy: proxy error for ${req.headers.host}${req.url} -- ${err.code || ''} ${err.message}`);
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502);
    res.end(`GUI proxy error: ${err.message}`);
  }
});

// Subdomain shape: <labName>--<nodeName>.<guiDomain> -- "--" rather than a
// single "-" as the delimiter since both commonly contain hyphens
// themselves (e.g. "pa-panorama-test"), same reasoning as old labber's own
// labber__<lab>__<node> domain-name convention. guiDomain is read fresh
// per request (configStore.get(), not cached at module load) so a Settings
// change takes effect immediately, consistent with how proxmox-client.js
// reads its own config.
//
// guiDomain accepts a comma-separated list, not just one domain -- this
// app's own dashboard is already reachable via two separate hostnames (the
// plain one, and a ".cloud." direct-ingress bypass that skips npmplus, see
// k3s-gitops' ingress.yaml), and web-rp needs to work the same way from
// either one. A single-domain guiDomain silently 404s every gui-proxy
// request made via whichever hostname wasn't configured -- confirmed
// happening for real (Settings only had the plain domain, every web-rp
// attempt via the .cloud. bypass 404'd, unrelated to the specific lab/node
// being tested).
function resolveTarget(host) {
  const guiDomains = (configStore.get().guiDomain || '').split(',').map((d) => d.trim()).filter(Boolean);
  if (!guiDomains.length || !host) return null;
  const hostname = host.split(':')[0];
  const guiDomain = guiDomains.find((d) => hostname.endsWith(`.${d}`));
  if (!guiDomain) return null;

  const label = hostname.slice(0, -(`.${guiDomain}`.length));
  // Neither lab nor node names are restricted against containing "--"
  // themselves (e.g. a lab named "prod--test"), so always splitting at the
  // *first* "--" can misattribute the split point -- for lab "prod--test"'s
  // node "fw1", the naive split reads labName="prod"/nodeName="test--fw1",
  // which 404s at best and silently routes into an unrelated same-named
  // lab's same-named node at worst (a real cross-lab collision, not just an
  // error). Instead, try each "--" occurrence left to right and take the
  // first split that resolves to an actual deployed (lab, node) pair.
  let node = null;
  for (let sep = label.indexOf('--'); sep !== -1; sep = label.indexOf('--', sep + 1)) {
    const labName = label.slice(0, sep);
    const nodeName = label.slice(sep + 2);
    node = labManager.getNodeTarget(labName, nodeName);
    if (node) break;
  }
  if (!node) return null;
  // kind (see lab-state.js's getNodeTarget) drives the F5-only rewrite
  // above -- everything else about routing is identical regardless of it.
  return { target: `https://${labManager.formatHostPort(node.ip, node.port || DEFAULT_TARGET_PORT)}`, kind: node.kind };
}

const server = http.createServer((req, res) => {
  const resolved = resolveTarget(req.headers.host);
  if (!resolved) {
    console.warn(`gui-proxy: no target for host "${req.headers.host}" (${req.url})`);
    res.writeHead(404);
    res.end('Unknown lab/node, no mgmt IP set for it, or GUI domain not configured in Settings');
    return;
  }
  const opts = { target: resolved.target };
  // Hands this request's response over to the proxyRes handler above
  // entirely (see F5_FRAMEBUST_RE's comment) instead of node-http-proxy
  // auto-piping it -- every other kind skips this and behaves exactly as
  // before.
  if (HTML_REWRITE_KINDS.has(resolved.kind)) {
    opts.selfHandleResponse = true;
    req._htmlRewrite = true;

    // See rewriteCache's comment above -- only these vendors' rewritten
    // responses are ever cached, and only for versioned asset URLs.
    if (req.method === 'GET' && req.url.includes('__version=')) {
      req._cacheKey = `${req.headers.host}${req.url}`;
      const cached = rewriteCache.get(req._cacheKey);
      if (cached) {
        res.writeHead(cached.statusCode, cached.headers);
        res.end(cached.body);
        return;
      }
    }
  }
  // Referer rewriting (see proxyReq above) needs the same target origin
  // resolveTarget() already computed here -- stashed on req rather than
  // recomputed, since resolveTarget()'s "--" search isn't free to redo.
  req._targetOrigin = resolved.target;
  proxy.web(req, res, opts);
});

server.on('upgrade', (req, socket, head) => {
  const resolved = resolveTarget(req.headers.host);
  if (!resolved) {
    console.warn(`gui-proxy: no target for host "${req.headers.host}" (${req.url}), dropping upgrade`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: resolved.target });
});

function start() {
  server.listen(GUI_PROXY_PORT, '0.0.0.0', () => {
    console.log(`labber-pve gui-proxy listening on port ${GUI_PROXY_PORT}`);
  });
}

module.exports = { start, GUI_PROXY_PORT };
