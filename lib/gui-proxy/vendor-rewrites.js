// Vendor-specific response rewrites for the web rp proxy: each one neutralizes a
// specific snippet in a device's own pages or JS bundle that breaks when the UI
// runs inside an iframe. New device fixes belong here, as narrow literal
// matches. Used by lib/gui-proxy.js (which decides which responses to rewrite).

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

// Is this the one PAN-OS JS bundle that carries the Ext.History / redirect bugs?
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
const isPanosMainBundle = (url) => /panos-panos-[\w-]+-main\.js/i.test(url);

function rewriteBody(body) {
  // Every regex below is a narrow, literal match against one specific
  // known vendor snippet -- harmless to run against every rewritten
  // vendor's response even when that particular snippet doesn't apply,
  // since none of them match anything on a different vendor's pages (or
  // on the wrong content type -- e.g. the PAN-OS JS-bundle patterns
  // never match real HTML, and vice versa).
  return body
    .replace(F5_FRAMEBUST_RE, '')
    .replace(F5_REDIRECT_XUI_CHECK_RE, 'true')
    .replace(PANOS_FRAMEBUST_RE, '')
    .replace(PANOS_LOGIN_FRAMEBUST_RE, "document.documentElement.style.display = 'block';")
    .replace(PANOS_HISTORY_HREF_RE, 'self.location.href')
    .replace(PANOS_HISTORY_HASH_RE, 'self.location.hash = token;')
    .replace(PANOS_REDIRECT_ASSIGN_RE, 'window.self.location.assign');
}

module.exports = { HTML_REWRITE_KINDS, isPanosMainBundle, rewriteBody };
