'use strict';

/**
 * Reverse proxy for /term/<slug>/* -> 127.0.0.1:<port>, WebSocket upgrades
 * included (spec §3.6).
 *
 * The path is passed through *unmodified*: ttyd is started with
 * `-b /term/<slug>` so it already serves under that prefix. Stripping the
 * prefix instead would make ttyd emit '/'-rooted asset, /token and /ws URLs
 * that 404 at this proxy.
 */

const httpProxy = require('http-proxy');

const registry = require('./registry');
const { isValidSlug } = require('./slug');

const MOUNT = '/term';

// Matches /term/<slug> and /term/<slug>/anything. The slug segment is taken
// raw and validated against [a-z0-9-] without decoding first, so percent
// escapes (%2e%2e, %2f) can never round-trip into a slug.
const TERM_PATH_RE = /^\/term\/([^/?#]+)(?:([/?#].*)?)$/;

const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
  // Keep the browser's Host header: ttyd generates URLs from it, and rewriting
  // it to 127.0.0.1:<port> would leak the internal port into the page.
  changeOrigin: false,
  // ttyd WebSockets are idle for long stretches; no timeout on the proxy leg.
  proxyTimeout: 0,
  timeout: 0,
});

// http-proxy emits 'error' on the proxy object for every failed exchange. The
// per-call callbacks below handle those, but an unhandled 'error' event on an
// EventEmitter would take the process down, so keep a listener attached.
proxy.on('error', () => {});

/**
 * @returns {{slug: string, port: number}}
 * @throws {{status: number, message: string}}
 */
function resolveTarget(url) {
  const m = TERM_PATH_RE.exec(url);
  if (!m) throw { status: 404, message: 'not a /term/<slug>/ path' };

  const slug = m[1];
  if (!isValidSlug(slug)) throw { status: 404, message: 'invalid project slug' };

  const entry = registry.get(slug);
  if (!entry) throw { status: 404, message: `no such project: ${slug}` };

  return { slug, port: entry.port };
}

const upstreamFor = (port) => `http://127.0.0.1:${port}`;

/** Turn a proxy-leg failure into something a human can act on. */
function upstreamError(err, slug, port) {
  if (err && err.code === 'ECONNREFUSED') {
    return {
      status: 502,
      message:
        `ttyd for "${slug}" is not listening on 127.0.0.1:${port}. ` +
        `Check: systemctl --user status ttyd@${slug}.service`,
    };
  }
  if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
    return { status: 502, message: `connection to ttyd for "${slug}" was reset` };
  }
  return { status: 502, message: `proxy error for "${slug}": ${(err && err.code) || err}` };
}

/**
 * Express middleware. Mount at the app root (not under /term) so the raw
 * req.url is visible, and mount it *before* any body parser: consuming the
 * request body here would leave nothing to forward upstream.
 */
function httpMiddleware(req, res, next) {
  if (req.url !== MOUNT && !req.url.startsWith(`${MOUNT}/`)) return next();

  let target;
  try {
    target = resolveTarget(req.url);
  } catch (e) {
    if (typeof e.status !== 'number') throw e;
    res.status(e.status).json({ error: e.message });
    return;
  }

  proxy.web(req, res, { target: upstreamFor(target.port) }, (err) => {
    const { status, message } = upstreamError(err, target.slug, target.port);
    console.warn(`[proxy] ${req.method} ${req.url} -> ${message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(status).json({ error: message });
  });
}

/** Reply on a raw socket, which is all we have during an upgrade. */
function refuseUpgrade(socket, status, message) {
  const text = { 400: 'Bad Request', 404: 'Not Found', 502: 'Bad Gateway' }[status] || 'Error';
  const body = JSON.stringify({ error: message });
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\n` +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n\r\n' +
        body
    );
  }
  socket.destroy();
}

/**
 * server.on('upgrade') handler. Express never sees upgrade requests, so this
 * is wired directly onto the http.Server.
 */
function handleUpgrade(req, socket, head) {
  socket.on('error', () => {}); // a client vanishing mid-handshake is routine

  let target;
  try {
    target = resolveTarget(req.url);
  } catch (e) {
    if (typeof e.status !== 'number') throw e;
    refuseUpgrade(socket, e.status, e.message);
    return;
  }

  proxy.ws(req, socket, head, { target: upstreamFor(target.port) }, (err) => {
    const { status, message } = upstreamError(err, target.slug, target.port);
    console.warn(`[proxy] UPGRADE ${req.url} -> ${message}`);
    refuseUpgrade(socket, status, message);
  });
}

function close() {
  proxy.close();
}

module.exports = { httpMiddleware, handleUpgrade, resolveTarget, close, MOUNT, TERM_PATH_RE };
