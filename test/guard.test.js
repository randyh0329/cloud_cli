'use strict';

/**
 * Same-origin enforcement and security headers. Behind Cloudflare Access every
 * browser request carries a valid session — including the ones another site
 * makes the browser send — so state-changing requests and WebSocket upgrades
 * must come from webterm's own origin.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');

process.env.WEBTERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-guard-'));
process.env.WEBTERM_PROJECTS_ROOT = process.env.WEBTERM_HOME;
process.env.WEBTERM_STUB_SUPERVISOR = '1';

const registry = require('../server/registry');
const guard = require('../server/guard');
const proxy = require('../server/proxy');
const { createApp } = require('../server/app');

let server;
let base;
let host;

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
);

function req(urlPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + urlPath, { method, headers });
    r.on('response', (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const json = (obj, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(obj),
});

function multipart(fields, headers = {}) {
  const boundary = '----webtermtest';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    const isFile = Buffer.isBuffer(value);
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"` +
          (isFile ? `; filename="x.png"\r\nContent-Type: image/png` : '') +
          '\r\n\r\n'
      ),
      isFile ? value : Buffer.from(String(value)),
      Buffer.from('\r\n')
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers },
    body: Buffer.concat(parts),
  };
}

function upgrade(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + urlPath, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    r.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    r.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', (err) => (err.code === 'ECONNRESET' ? resolve('reset') : reject(err)));
    r.end();
  });
}

before(async () => {
  await registry.init();
  await registry.transaction((draft) => {
    draft.guarded = { slug: 'guarded', port: 27993, cwd: os.tmpdir(), created_at: new Date().toISOString() };
  });
  server = http.createServer(createApp());
  server.on('upgrade', (r, socket, head) => {
    if (!guard.authorizeUpgrade(r, socket)) return;
    proxy.handleUpgrade(r, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  host = `127.0.0.1:${server.address().port}`;
  base = `http://${host}`;
});

after(() => {
  server.close();
  proxy.close();
  fs.rmSync(process.env.WEBTERM_HOME, { recursive: true, force: true });
});

// ── state-changing requests ─────────────────────────────────────────────

test('cross-origin project create is refused; same-origin and non-browser clients are not', async () => {
  const evil = await req('/api/projects', json({ slug: 'evil-made' }, { origin: 'https://evil.example' }));
  assert.equal(evil.status, 403);
  assert.equal(registry.get('evil-made'), null, 'nothing was created');

  const mine = await req('/api/projects', json({ slug: 'mine' }, { origin: base }));
  assert.equal(mine.status, 201);

  const curl = await req('/api/projects', json({ slug: 'from-curl' }));
  assert.equal(curl.status, 201, 'no Origin, no Sec-Fetch-Site: a script on the host');
});

test('cross-site upload (a CORS "simple" request) is refused before anything is saved', async () => {
  const res = await req('/api/upload', multipart({ project: 'guarded', file: PNG }, { origin: 'https://evil.example' }));
  assert.equal(res.status, 403);
  const dir = path.join(process.env.WEBTERM_HOME, 'screenshots', 'guarded');
  assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'no file written');
});

test('cross-origin delete is refused', async () => {
  const res = await req('/api/projects/mine', { method: 'DELETE', headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  assert.ok(registry.get('mine'), 'still there');
});

test('Sec-Fetch-Site: cross-site without an Origin is refused', async () => {
  const res = await req('/api/projects', json({ slug: 'sfs' }, { 'sec-fetch-site': 'cross-site' }));
  assert.equal(res.status, 403);
});

test('Origin: null (sandboxed iframe, data: URL) and unparseable Origins are refused', async () => {
  assert.equal((await req('/api/projects', json({ slug: 'n1' }, { origin: 'null' }))).status, 403);
  assert.equal((await req('/api/projects', json({ slug: 'n2' }, { origin: 'not a url' }))).status, 403);
});

test('same host, different port is a different origin', async () => {
  const port = Number(host.split(':')[1]) + 1;
  const res = await req('/api/projects', json({ slug: 'p1' }, { origin: `http://127.0.0.1:${port}` }));
  assert.equal(res.status, 403);
});

test('safe methods are not origin-checked', async () => {
  const res = await req('/api/projects', { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 200, 'CORS already stops the other site reading the answer');
});

// ── WebSocket upgrades ──────────────────────────────────────────────────

test('a cross-origin WebSocket upgrade to a terminal is refused', async () => {
  assert.equal(await upgrade('/term/guarded/ws', { origin: 'https://evil.example' }), 403);
  assert.equal(await upgrade('/term/guarded/ws', { origin: 'null' }), 403);
});

test('a same-origin upgrade gets through the guard', async () => {
  // 502: past the guard, refused only by the missing upstream ttyd.
  assert.equal(await upgrade('/term/guarded/ws', { origin: base }), 502);
});

// ── headers ─────────────────────────────────────────────────────────────

test('the UI cannot be framed and carries a CSP', async () => {
  const res = await req('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(res.headers['content-security-policy'], /script-src 'self'(;|$)/);
});

test('proxied ttyd responses get anti-framing headers but not the UI CSP', async () => {
  const res = await req('/term/guarded/');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['content-security-policy'], undefined);
});

test('sameOrigin() compares host case-insensitively', () => {
  assert.equal(guard.sameOrigin({ headers: { origin: 'https://Term.Example.com', host: 'term.example.COM' } }), true);
  assert.equal(guard.sameOrigin({ headers: { origin: 'https://term.example.com', host: 'term.example.com.evil' } }), false);
  assert.equal(guard.sameOrigin({ headers: { origin: 'https://term.example.com' } }), false, 'no Host header');
});
