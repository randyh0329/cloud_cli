'use strict';

/**
 * The dev-mode password gate. The property under test throughout is that every
 * route to a shell is behind it — the page, /api/*, the /term proxy and the
 * WebSocket upgrade — because any one of them left open makes the other three
 * pointless.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, before, after, beforeEach } = require('node:test');

process.env.WEBTERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-auth-'));
process.env.WEBTERM_STUB_SUPERVISOR = '1';

const registry = require('../server/registry');
const config = require('../server/config');
const auth = require('../server/auth');
const proxy = require('../server/proxy');
const { createApp } = require('../server/app');

const PASSWORD = 'correct horse battery staple';

let server;
let base;

/** fetch() that never follows redirects and never carries a cookie by accident. */
async function req(urlPath, { method = 'GET', cookie, body, headers = {} } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    redirect: 'manual',
    headers: {
      ...headers,
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const form = (obj) => new URLSearchParams(obj).toString();

/** The Set-Cookie value reduced to what a browser would send back. */
function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

async function login(password = PASSWORD, next) {
  const res = await req(auth.LOGIN_PATH, {
    method: 'POST',
    body: form(next === undefined ? { password } : { password, next }),
  });
  return { res, cookie: cookieFrom(res) };
}

before(async () => {
  config.DEV_PASSWORD = PASSWORD;
  await registry.init();
  // A project the proxy will resolve; there is no ttyd behind it, and there
  // does not need to be — every request here is meant to be refused earlier,
  // and "refused by the upstream instead" is how the pass-through cases assert
  // they got past the gate. The port is deliberately outside the real pool so
  // a webterm actually running on this host cannot answer for it.
  await registry.transaction((draft) => {
    draft.gated = {
      slug: 'gated',
      port: 27991,
      cwd: os.tmpdir(),
      created_at: new Date().toISOString(),
    };
  });
  server = http.createServer(createApp());
  server.on('upgrade', (r, socket, head) => {
    if (!auth.authorizeUpgrade(r, socket)) return;
    proxy.handleUpgrade(r, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  proxy.close();
  fs.rmSync(process.env.WEBTERM_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  config.DEV_PASSWORD = PASSWORD;
  auth.resetAttempts();
});

// ── the gate ────────────────────────────────────────────────────────────

test('the UI, the API and the terminal proxy are all gated', async () => {
  const ui = await req('/');
  assert.equal(ui.status, 302);
  assert.match(ui.headers.get('location'), /^\/login\?next=/);

  const api = await req('/api/projects');
  assert.equal(api.status, 401, '/api/* answers JSON 401, not a redirect');
  assert.deepEqual(JSON.parse(api.text), { error: 'not signed in' });

  const term = await req('/term/gated/');
  assert.equal(term.status, 302, 'the proxy is behind the gate, not in front of it');
  assert.match(term.headers.get('location'), /^\/login\?next=%2Fterm%2Fgated%2F$/);
});

test('the login page is reachable without a session', async () => {
  const res = await req(auth.LOGIN_PATH);
  assert.equal(res.status, 200);
  assert.match(res.text, /name="password"/);
});

test('the right password issues a session that opens every door', async () => {
  const { res, cookie } = await login();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  assert.match(res.headers.get('set-cookie'), /HttpOnly/);
  assert.match(res.headers.get('set-cookie'), /SameSite=Strict/);
  assert.ok(cookie.startsWith(`${auth.COOKIE}=`));

  assert.equal((await req('/', { cookie })).status, 200);
  assert.equal((await req('/api/projects', { cookie })).status, 200);
  // 502: past the gate, into the proxy, which finds no ttyd on 7681. Being
  // refused by the *upstream* is what proves the gate let it through.
  assert.equal((await req('/term/gated/', { cookie })).status, 502);
});

test('the wrong password is refused and never issues a cookie', async () => {
  const { res, cookie } = await login('hunter2');
  assert.equal(res.status, 401);
  assert.equal(cookie, null);
  assert.match(res.text, /Wrong password/);
});

test('an empty password never authenticates, even against an empty secret', async () => {
  assert.equal(auth.checkPassword(''), false);
  config.DEV_PASSWORD = '';
  assert.equal(auth.checkPassword(''), false);
});

// ── tokens ──────────────────────────────────────────────────────────────

test('a tampered or expired token is rejected', async () => {
  const token = auth.issueToken();
  assert.equal(auth.verifyToken(token), true);

  const [exp, sig] = token.split('.');
  assert.equal(auth.verifyToken(`${exp}.${'0'.repeat(sig.length)}`), false, 'forged signature');
  assert.equal(auth.verifyToken(`${Number(exp) + 3600_000}.${sig}`), false, 'extended expiry');
  assert.equal(auth.verifyToken(token, Number(exp) + 1), false, 'expired');
  assert.equal(auth.verifyToken(`${exp}.`), false);
  assert.equal(auth.verifyToken('garbage'), false);
  assert.equal(auth.verifyToken(undefined), false);
});

test('changing the password invalidates outstanding sessions', async () => {
  const { cookie } = await login();
  assert.equal((await req('/api/projects', { cookie })).status, 200);

  config.DEV_PASSWORD = 'a different password';
  assert.equal((await req('/api/projects', { cookie })).status, 401);
});

test('the session key is persisted 0600 so a restart does not sign you out', () => {
  auth.issueToken();
  const mode = fs.statSync(auth.KEY_FILE).mode & 0o777;
  assert.equal(mode, 0o600);

  const token = auth.issueToken();
  auth.resetKey(); // as if the process had restarted
  assert.equal(auth.verifyToken(token), true, 'the key was re-read from disk');
});

// ── the WebSocket leg ───────────────────────────────────────────────────

// A raw socket, not fetch(): Express never sees upgrade requests, so this is
// the only way to reach the handler that actually guards the terminal socket.
test('an unauthenticated upgrade is refused before it reaches ttyd', async () => {
  assert.match(await rawUpgrade(null), /^HTTP\/1\.1 401/);
  assert.match(await rawUpgrade(`${auth.COOKIE}=forged.deadbeef`), /^HTTP\/1\.1 401/);
});

test('an authenticated upgrade gets past the gate', async () => {
  const { cookie } = await login();
  const status = await rawUpgrade(cookie);
  // 502 from the proxy: no ttyd is listening. Anything but 401 means the gate
  // opened, which is the assertion.
  assert.doesNotMatch(status, /^HTTP\/1\.1 401/);
  assert.match(status, /^HTTP\/1\.1 502/);
});

/** Hand-rolled upgrade so we control the cookie exactly. */
function rawUpgrade(cookie) {
  const net = require('node:net');
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /term/gated/ws HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Protocol: tty\r\n' +
          (cookie ? `Cookie: ${cookie}\r\n` : '') +
          '\r\n'
      );
    });
    let buf = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`upgrade timed out; saw: ${buf}`));
    });
    socket.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n')) {
        socket.destroy();
        resolve(buf.split('\r\n')[0]);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(buf.split('\r\n')[0] || ''));
  });
}

// ── brute force and open redirect ───────────────────────────────────────

test('repeated wrong passwords lock the source address out', async () => {
  for (let i = 0; i < auth.MAX_FAILS; i += 1) {
    assert.equal((await login('wrong')).res.status, 401);
  }
  const locked = await login(PASSWORD);
  assert.equal(locked.res.status, 429, 'even the right password waits out the lockout');
  assert.equal(locked.cookie, null);
  assert.match(locked.res.text, /Too many attempts/);
});

test('next= cannot be turned into an open redirect', async () => {
  assert.equal(auth.safeNext('/term/app/'), '/term/app/');
  assert.equal(auth.safeNext('//evil.example.com/'), '/');
  assert.equal(auth.safeNext('https://evil.example.com'), '/');
  assert.equal(auth.safeNext('/\\evil.example.com'), '/');
  assert.equal(auth.safeNext(undefined), '/');

  const { res } = await login(PASSWORD, 'https://evil.example.com/');
  assert.equal(res.headers.get('location'), '/');
});

test('logout clears the cookie', async () => {
  const { cookie } = await login();
  const res = await req('/logout', { method: 'POST', cookie });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});

// ── off by default ──────────────────────────────────────────────────────

test('with no password set the gate is entirely absent', async () => {
  config.DEV_PASSWORD = '';
  assert.equal(auth.enabled(), false);
  assert.equal((await req('/api/projects')).status, 200, 'no redirect, no 401');
  assert.equal(auth.authenticated({ headers: {} }), true);
});
