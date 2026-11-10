'use strict';

/**
 * Browser-side hardening: same-origin enforcement and response headers.
 *
 * Cloudflare Access authenticates the *browser*, so every request that browser
 * sends — including ones a different site makes it send — arrives carrying a
 * valid Access session. Two things follow:
 *
 *  - Cross-site requests. A page on evil.example can make the browser POST a
 *    multipart form to /api/upload (a "simple" request, no CORS preflight), or
 *    open a WebSocket to /term/<slug>/ws (WebSockets are not subject to CORS at
 *    all). So state-changing requests and every upgrade must come from this
 *    origin. ttyd's own `-O` repeats the WebSocket check one hop further in.
 *
 *  - Framing. The UI's tab × is "kill this tmux session and everything in it";
 *    a page that frames us can trick a click onto it. frame-ancestors 'none'.
 *
 * Requests with no Origin and no Sec-Fetch-Site (curl, scripts on the host)
 * are allowed: they are not a browser being steered by another site, and they
 * still have to get past Access / the dev gate.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * xterm.js's DOM renderer injects <style> elements, hence 'unsafe-inline' for
 * styles only. Scripts are all same-origin files (public/index.html has no
 * inline script), so script-src stays 'self'. 'self' in connect-src covers
 * same-origin ws:/wss: in CSP3 browsers.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** True if the request did not come from another site. Works on a raw IncomingMessage. */
function sameOrigin(req) {
  const h = req.headers || {};
  const origin = h.origin;
  if (origin === undefined) {
    // No Origin: either a non-browser client, or a same-origin GET. Browsers
    // that send Sec-Fetch-Site tell us outright when it is cross-site.
    return h['sec-fetch-site'] !== 'cross-site';
  }
  if (origin === 'null') return false; // sandboxed iframe, file://, data: …
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return Boolean(h.host) && host.toLowerCase() === String(h.host).toLowerCase();
}

/** Express middleware: headers on every response, origin check on unsafe methods. */
function middleware(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // ttyd's own page under /term/<slug>/ is served through the proxy and has
  // inline scripts; it gets the anti-framing headers but not our CSP.
  if (!req.url.startsWith('/term/')) res.setHeader('Content-Security-Policy', CSP);

  if (SAFE_METHODS.has(req.method) || sameOrigin(req)) return next();
  console.warn(
    `[guard] refused cross-origin ${req.method} ${req.originalUrl} (origin ${req.headers.origin || '-'}, ` +
      `sec-fetch-site ${req.headers['sec-fetch-site'] || '-'})`
  );
  res.status(403).json({ error: 'cross-origin request refused' });
}

/** The WebSocket leg. */
function authorizeUpgrade(req, socket) {
  if (sameOrigin(req)) return true;
  console.warn(`[guard] refused cross-origin upgrade ${req.url} (origin ${req.headers.origin || '-'})`);
  if (socket.writable) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
  socket.destroy();
  return false;
}

module.exports = { middleware, authorizeUpgrade, sameOrigin, CSP };
