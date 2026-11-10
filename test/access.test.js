'use strict';

/**
 * Cloudflare Access JWT verification. The property under test: with
 * WEBTERM_ACCESS_TEAM/_AUD set, nothing reaches the UI, the API, the /term
 * proxy or the WebSocket upgrade without a token Cloudflare signed for *this*
 * application — and every way of almost-forging one is refused.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, before, after, beforeEach } = require('node:test');

process.env.WEBTERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-access-'));
process.env.WEBTERM_STUB_SUPERVISOR = '1';
process.env.WEBTERM_ACCESS_TEAM = 'unit-test';
process.env.WEBTERM_ACCESS_AUD = 'aud-primary, aud-secondary';

const registry = require('../server/registry');
const config = require('../server/config');
const access = require('../server/access');
const auth = require('../server/auth');
const guard = require('../server/guard');
const proxy = require('../server/proxy');
const { createApp } = require('../server/app');

const ISS = 'https://unit-test.cloudflareaccess.com';

const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (pair, kid) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });

let published; // what the stub certs endpoint returns
let fetches = 0;

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function sign({ header = {}, claims = {}, key = signingKey.privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header });
  const c = b64({ iss: ISS, aud: ['aud-primary'], exp: now + 600, iat: now, email: 'me@example.com', ...claims });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${c}`), key).toString('base64url');
  return `${h}.${c}.${sig}`;
}

let server;
let base;

function req(urlPath, { token, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + urlPath, {
      method,
      headers: token ? { [access.HEADER]: token } : {},
    });
    r.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.end();
  });
}

/** Resolve with the status the server answers an upgrade with (101 if it upgrades). */
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
    r.on('upgrade', (res, socket) => {
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
  access._setFetcher(async () => {
    fetches += 1;
    return { keys: published };
  });
  await registry.init();
  await registry.transaction((draft) => {
    draft.gated = { slug: 'gated', port: 27992, cwd: os.tmpdir(), created_at: new Date().toISOString() };
  });
  server = http.createServer(createApp());
  server.on('upgrade', async (r, socket, head) => {
    socket.on('error', () => {});
    if (!(await access.authorizeUpgrade(r, socket))) return;
    if (!auth.authorizeUpgrade(r, socket)) return;
    if (!guard.authorizeUpgrade(r, socket)) return;
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
  published = [jwkOf(signingKey, 'k1')];
  access._setFetcher(async () => {
    fetches += 1;
    return { keys: published };
  });
  fetches = 0;
});

test('config: team name is normalised and both values are required together', () => {
  assert.equal(config.ACCESS_TEAM_DOMAIN, 'unit-test.cloudflareaccess.com');
  assert.deepEqual(config.ACCESS_AUD, ['aud-primary', 'aud-secondary']);
  assert.equal(access.enabled(), true);
  assert.equal(access.halfConfigured(), false);
});

test('no token: UI, API, terminal proxy and WebSocket upgrade are all refused', async () => {
  assert.equal(await req('/'), 403);
  assert.equal(await req('/api/projects'), 403);
  assert.equal(await req('/api/health'), 403, 'no exemptions, health included');
  assert.equal(await req('/term/gated/'), 403);
  assert.equal(await upgrade('/term/gated/ws'), 403);
});

test('a valid token opens every door', async () => {
  const token = sign();
  assert.equal(await req('/', { token }), 200);
  assert.equal(await req('/api/projects', { token }), 200);
  // 502: past every gate, refused only by the missing upstream ttyd.
  assert.equal(await req('/term/gated/', { token }), 502);
  assert.equal(await upgrade('/term/gated/ws', { [access.HEADER]: token }), 502);
});

test('any listed audience is accepted, and aud may be a string', async () => {
  assert.equal(await req('/api/projects', { token: sign({ claims: { aud: 'aud-secondary' } }) }), 200);
});

const forgeries = {
  'wrong audience': () => sign({ claims: { aud: ['someone-elses-app'] } }),
  'wrong issuer': () => sign({ claims: { iss: 'https://evil.cloudflareaccess.com' } }),
  expired: () => sign({ claims: { exp: Math.floor(Date.now() / 1000) - 3600 } }),
  'not yet valid': () => sign({ claims: { nbf: Math.floor(Date.now() / 1000) + 3600 } }),
  'no exp': () => sign({ claims: { exp: undefined } }),
  'signed by another key under a known kid': () => sign({ key: otherKey.privateKey }),
  'alg none': () => `${b64({ alg: 'none', kid: 'k1' })}.${b64({ iss: ISS, aud: ['aud-primary'], exp: 9e9 })}.`,
  'HS256 keyed with the public key': () => {
    const h = b64({ alg: 'HS256', kid: 'k1' });
    const c = b64({ iss: ISS, aud: ['aud-primary'], exp: 9e9 });
    const pem = signingKey.publicKey.export({ type: 'spki', format: 'pem' });
    return `${h}.${c}.${crypto.createHmac('sha256', pem).update(`${h}.${c}`).digest('base64url')}`;
  },
  'tampered claims': () => {
    const [h, , s] = sign().split('.');
    return `${h}.${b64({ iss: ISS, aud: ['aud-primary'], exp: 9e9, email: 'attacker@example.com' })}.${s}`;
  },
  garbage: () => 'not.a.jwt',
  'two parts': () => 'abc.def',
};

for (const [name, make] of Object.entries(forgeries)) {
  test(`refused: ${name}`, async () => {
    const token = make();
    assert.equal(await req('/api/projects', { token }), 403);
    assert.equal(await upgrade('/term/gated/ws', { [access.HEADER]: token }), 403);
  });
}

test('key rotation: an unknown kid triggers one refresh and then verifies', async () => {
  await access.refreshKeys({ force: true });
  const before = fetches;
  const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  published = [jwkOf(signingKey, 'k1'), jwkOf(rotated, 'k2')];
  // Let the refresh rate limit lapse for this one test.
  access._setFetcher(async () => {
    fetches += 1;
    return { keys: published };
  });
  const token = sign({ header: { kid: 'k2' }, key: rotated.privateKey });
  assert.equal(await req('/api/projects', { token }), 200);
  assert.ok(fetches > before);
});

test('a flood of unknown kids does not turn into a flood of key fetches', async () => {
  await access.refreshKeys({ force: true });
  const start = fetches;
  for (let i = 0; i < 20; i += 1) {
    assert.equal(await req('/api/projects', { token: sign({ header: { kid: `bogus-${i}` } }) }), 403);
  }
  assert.equal(fetches, start, 'refresh is rate-limited');
});

test('if the certs endpoint is down, requests fail closed', async () => {
  access._setFetcher(async () => {
    throw new Error('network down');
  });
  assert.equal(await req('/api/projects', { token: sign() }), 403);
  assert.equal(await upgrade('/term/gated/ws', { [access.HEADER]: sign() }), 403);
});
