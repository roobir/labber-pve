// Cross-site request guard for the session-cookie surfaces (/api changes,
// /login, /logout, and every websocket). The session cookie is SameSite=Lax,
// which does not stop a request from a *same-site* page -- and the web rp
// serves lab appliances' own web UIs from sibling subdomains
// (<lab>--<node>.gui.<domain>), so a page there could otherwise deploy,
// destroy or open a console with the signed-in user's cookie. A multipart
// form POST (template upload) needs no CORS preflight either.
//
// A browser always says where a request came from (Origin on POST/PUT/DELETE
// and websocket upgrades, Sec-Fetch-Site on modern browsers); its host must be
// the host the request was sent to. Requests with neither header are not from
// a browser page (curl, scripts) and carry no ambient cookie risk, so they
// pass. Only hostnames are compared: a proxy may or may not keep the port.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostnameOf(value) {
  return String(value || '').split(',')[0].trim().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

function requestHosts(req) {
  const hosts = new Set([hostnameOf(req.headers.host)]);
  if (req.headers['x-forwarded-host']) hosts.add(hostnameOf(req.headers['x-forwarded-host']));
  hosts.delete('');
  return hosts;
}

// -> null when allowed, else the reason it was refused.
function crossSiteReason(req) {
  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch (e) {
      return `unreadable Origin "${origin}"`;
    }
    return requestHosts(req).has(originHost) ? null : `Origin ${origin} is not this site`;
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return `Sec-Fetch-Site ${site}`;
  return null;
}

// Express middleware: state-changing requests only (GETs change nothing).
function sameOriginGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const reason = crossSiteReason(req);
  if (!reason) return next();
  console.warn(`same-origin: refused ${req.method} ${req.originalUrl} -- ${reason}`);
  return res.status(403).json({ error: 'cross-site request refused' });
}

module.exports = { sameOriginGuard, crossSiteReason };
