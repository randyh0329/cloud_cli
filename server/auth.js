'use strict';

/**
 * Dev-mode password gate (spec §5 says Cloudflare Access; this is the stand-in
 * for testing from a real browser before the tunnel exists).
 *
 * Off unless WEBTERM_DEV_PASSWORD is set. When it is on, *everything* is behind
 * it — the UI, /api/*, the /term/<slug>/* proxy and the WebSocket upgrade —
 * because each of those is a route to the same interactive shell.
 *
 * What this is not: a substitute for Access. There is no TLS here, so the
 * password and the whole terminal session cross the network in clear text, and
 * a single shared password in front of a shell is one guess away from a remote
 * root-equivalent. Bind to a public address only for as long as the test takes,
 * and firewall it to your own address while you do.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('./config');

const COOKIE = 'webterm_dev';
const KEY_FILE = path.join(config.WEBTERM_HOME, 'dev-session.key');
const LOGIN_PATH = '/login';

// Brute-force budget per source address.
const MAX_FAILS = 5;
const LOCKOUT_MS = 60_000;
// Every rejected password costs this much, so an attacker gets ~4 tries/second
// per connection instead of as many as the event loop will serve.
const FAIL_DELAY_MS = 250;

const enabled = () => Boolean(config.DEV_PASSWORD);

/**
 * A key on disk rather than one per process, so restarting webterm does not
 * log you out mid-test. 0600, and it never leaves the box.
 */
let cachedKey = null;
function sessionKey() {
  if (cachedKey) return cachedKey;
  try {
    cachedKey = fs.readFileSync(KEY_FILE);
    if (cachedKey.length >= 32) return cachedKey;
  } catch {
    /* first run */
  }
  cachedKey = crypto.randomBytes(32);
  fs.mkdirSync(config.WEBTERM_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${KEY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, cachedKey, { mode: 0o600 });
  fs.renameSync(tmp, KEY_FILE);
  return cachedKey;
}

/** Forget the cached key — tests only. */
function resetKey() {
  cachedKey = null;
}

const passwordDigest = () => crypto.createHash('sha256').update(config.DEV_PASSWORD).digest();

/**
 * Signature covers the expiry *and* the current password, so changing
 * WEBTERM_DEV_PASSWORD invalidates every outstanding session.
 */
function sign(exp) {
  return crypto
    .createHmac('sha256', sessionKey())
    .update(`${exp}.`)
    .update(passwordDigest())
    .digest('hex');
}

function issueToken(now = Date.now()) {
  const exp = now + config.DEV_SESSION_MS;
  return `${exp}.${sign(exp)}`;
}

function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(exp) || exp <= now) return false;

  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  const want = Buffer.from(sign(exp), 'utf8');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function checkPassword(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  // Both sides are fixed-length digests, so length never leaks and
  // timingSafeEqual cannot throw.
  return crypto.timingSafeEqual(a, passwordDigest());
}

/** Minimal RFC 6265 cookie parse — we only ever look for one name. */
function cookieValue(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** True if this request carries a valid session. Works on a raw IncomingMessage. */
function authenticated(req) {
  if (!enabled()) return true;
  return verifyToken(cookieValue(req.headers && req.headers.cookie, COOKIE));
}

// ── brute-force throttle ────────────────────────────────────────────────
const attempts = new Map(); // ip -> {fails, until}

const clientIp = (req) =>
  (req.socket && (req.socket.remoteAddress || req.socket.remoteAddr)) || 'unknown';

function lockedFor(ip, now = Date.now()) {
  const a = attempts.get(ip);
  if (!a || a.until <= now) return 0;
  return a.until - now;
}

// Bound the table: one entry per source address that ever failed would
// otherwise grow without limit under a spray from many addresses.
const MAX_TRACKED = 10_000;

function noteFailure(ip, now = Date.now()) {
  if (attempts.size >= MAX_TRACKED && !attempts.has(ip)) {
    for (const [k, v] of attempts) if (v.until <= now) attempts.delete(k);
    if (attempts.size >= MAX_TRACKED) attempts.delete(attempts.keys().next().value);
  }
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) {
    a.until = now + LOCKOUT_MS;
    a.fails = 0; // the lockout replaces the count; a fresh window starts after
  }
  attempts.set(ip, a);
}

const noteSuccess = (ip) => attempts.delete(ip);

/** Tests only. */
function resetAttempts() {
  attempts.clear();
}

// ── HTTP surface ────────────────────────────────────────────────────────

function setCookie(res, token) {
  // No Secure flag: dev mode is plain HTTP, and a Secure cookie would simply
  // be dropped. That is the same clear-text exposure the banner warns about.
  const maxAge = Math.floor(config.DEV_SESSION_MS / 1000);
  res.setHeader(
    'set-cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
  );
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage({ error = '', next = '/' } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>webterm — sign in</title>
<style>
  :root { color-scheme: dark; --bg:#0d1017; --bar:#161a22; --line:#262c38;
          --fg:#d5dae2; --dim:#7f8899; --accent:#7aa2f7; --bad:#f7768e; }
  html,body { height:100%; margin:0; background:var(--bg); color:var(--fg);
              font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { display:grid; place-items:center; }
  form { background:var(--bar); border:1px solid var(--line); border-radius:10px;
         padding:28px 30px; width:min(92vw,360px); }
  h1 { font-size:17px; margin:0 0 4px; }
  p  { color:var(--dim); font-size:12.5px; line-height:1.5; margin:0 0 18px; }
  label { display:block; font-size:12px; color:var(--dim); margin-bottom:6px; }
  input { width:100%; padding:9px 11px; border-radius:6px; border:1px solid var(--line);
          background:#0d1017; color:var(--fg); font-size:14px; }
  input:focus { outline:none; border-color:var(--accent); }
  button { width:100%; margin-top:14px; padding:9px; border:0; border-radius:6px;
           background:var(--accent); color:#0d1017; font-size:14px; font-weight:600; cursor:pointer; }
  .err { color:var(--bad); font-size:12.5px; margin:12px 0 0; }
</style></head>
<body>
  <form method="POST" action="${esc(LOGIN_PATH)}">
    <h1>webterm</h1>
    <p>Dev-mode password gate. This connection is not encrypted — do not use a
       password you use anywhere else.</p>
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
    <button type="submit">Sign in</button>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
  </form>
</body></html>`;
}

/**
 * Only ever redirect within this origin. Without this check, /login?next=
 * is an open redirect, and an open redirect in front of a login form is how
 * you get a convincing credential-phishing link.
 */
function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.includes('\\')) return '/';
  return value;
}

/** Read an application/x-www-form-urlencoded body without a body-parser dep. */
function readForm(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('login form too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

/**
 * Express middleware. Mount it first: it must run before the /term proxy and
 * before express.static, or the gate has holes in it.
 */
async function middleware(req, res, next) {
  if (!enabled()) return next();

  if (req.path === LOGIN_PATH) {
    if (req.method === 'GET') {
      res.type('html').send(loginPage({ next: safeNext(req.query.next) }));
      return;
    }
    if (req.method === 'POST') {
      const ip = clientIp(req);
      const wait = lockedFor(ip);
      if (wait > 0) {
        res
          .status(429)
          .type('html')
          .send(loginPage({ error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` }));
        return;
      }
      let form;
      try {
        form = await readForm(req);
      } catch {
        res.status(400).type('html').send(loginPage({ error: 'Malformed form submission.' }));
        return;
      }
      const target = safeNext(form.get('next'));
      if (!checkPassword(form.get('password'))) {
        noteFailure(ip);
        console.warn(`[auth] failed login from ${ip}`);
        await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
        res.status(401).type('html').send(loginPage({ error: 'Wrong password.', next: target }));
        return;
      }
      noteSuccess(ip);
      console.log(`[auth] login from ${ip}`);
      setCookie(res, issueToken());
      res.redirect(303, target);
      return;
    }
  }

  if (authenticated(req)) return next();

  // An unauthenticated XHR should not be answered with a login page: the
  // frontend would render HTML into a JSON error path.
  if (req.path.startsWith('/api/') || req.get('accept') === 'application/json') {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  res.redirect(302, `${LOGIN_PATH}?next=${encodeURIComponent(req.originalUrl || '/')}`);
}

/** Express route: drop the session. */
function logout(req, res) {
  res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.redirect(303, LOGIN_PATH);
}

/**
 * The WebSocket leg. Express never sees upgrades, so without this the terminal
 * socket — the one that actually carries the shell — would be unauthenticated
 * while the page in front of it asked for a password.
 */
function authorizeUpgrade(req, socket) {
  if (authenticated(req)) return true;
  console.warn(`[auth] refused unauthenticated upgrade ${req.url} from ${clientIp(req)}`);
  if (socket.writable) {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
    );
  }
  socket.destroy();
  return false;
}

module.exports = {
  COOKIE,
  LOGIN_PATH,
  KEY_FILE,
  MAX_FAILS,
  enabled,
  middleware,
  logout,
  authenticated,
  authorizeUpgrade,
  issueToken,
  verifyToken,
  checkPassword,
  cookieValue,
  safeNext,
  resetKey,
  resetAttempts,
};
