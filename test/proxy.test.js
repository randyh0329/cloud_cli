'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { WebSocketServer, WebSocket } = require('ws');

process.env.WEBTERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-proxy-'));
process.env.WEBTERM_STUB_SUPERVISOR = '1';

const registry = require('../server/registry');
const proxy = require('../server/proxy');
const { createApp } = require('../server/app');

let app; // the webterm server under test
let base; // http://127.0.0.1:<port>
const upstreams = new Map(); // slug -> fake ttyd

/**
 * A stand-in for ttyd started with `-b /term/<slug>`: it serves only under that
 * prefix and exposes a `tty`-subprotocol WebSocket at <prefix>/ws, so any
 * path mangling by the proxy shows up as a 404 here.
 */
function fakeTtyd(slug) {
  const prefix = `/term/${slug}`;
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (!req.url.startsWith(prefix)) {
        res.writeHead(404).end('ttyd: outside base-path');
        return;
      }
      if (req.url === `${prefix}/token`) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":""}');
        return;
      }
      if (req.url === `${prefix}/big`) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        for (let i = 0; i < 64; i += 1) res.write('x'.repeat(16 * 1024));
        res.end();
        return;
      }
      if (req.url.startsWith(`${prefix}/echo`)) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ method: req.method, url: req.url, body })
        );
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<html><body>ttyd ${slug}</body></html>`);
    });
  });

  const wss = new WebSocketServer({ server, path: `${prefix}/ws`, handleProtocols: () => 'tty' });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
    ws.send(`hello from ${slug}`);
  });

  return { server, wss, seen, prefix };
}

async function startUpstream(slug, port) {
  const u = fakeTtyd(slug);
  await new Promise((res, rej) => {
    u.server.once('error', rej);
    u.server.listen(port, '127.0.0.1', res);
  });
  upstreams.set(slug, u);
  return u;
}

async function createProject(slug) {
  const entry = await registry.transaction((d) => {
    const port = registry.allocatePort(d);
    const rec = {
      port,
      cwd: '/tmp',
      created_at: new Date().toISOString(),
      screenshot_dir: '/tmp',
    };
    d[slug] = rec;
    return rec;
  });
  return entry.port;
}

const get = async (p, opts) => {
  const res = await fetch(base + p, opts);
  return { status: res.status, text: await res.text(), headers: res.headers };
};

/**
 * Write a request line straight onto a socket.
 *
 * Neither fetch() nor http.request can express these cases: undici normalises
 * the target ("%2e%2e" -> "..", "/term/../" -> "/") and http.request rejects
 * unescaped characters outright. Both would silently test the client instead
 * of the server, so the bytes go on the wire by hand.
 */
function rawGet(rawTarget) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(app.address().port, '127.0.0.1', () => {
      sock.write(`GET ${rawTarget} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => (raw += c));
    sock.on('error', reject);
    sock.on('close', () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0);
      resolve({ status, text: raw.split('\r\n\r\n').slice(1).join('\r\n\r\n'), raw });
    });
  });
}

/**
 * Open a ws:// connection through the proxy.
 *
 * Messages are queued from the moment the socket exists, because the upstream
 * greets on connect and that frame can land before 'open' resolves. `next()`
 * drains the queue first and only then waits, so no message can be missed.
 */
function wsConnect(p, protocols, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace('http://', 'ws://') + p, protocols);
    const queue = [];
    let waiter = null;

    ws.on('message', (data) => {
      const buf = Buffer.from(data);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(buf);
      } else {
        queue.push(buf);
      }
    });

    const next = () =>
      new Promise((res, rej) => {
        if (queue.length) return res(queue.shift());
        const timer = setTimeout(() => rej(new Error(`no ws message within ${timeoutMs}ms`)), timeoutMs);
        waiter = (buf) => {
          clearTimeout(timer);
          res(buf);
        };
      });

    const settle = (v) => {
      clearTimeout(handshakeTimer);
      resolve(v);
    };
    const handshakeTimer = setTimeout(
      () => settle({ ok: false, status: null, error: `handshake timed out after ${timeoutMs}ms` }),
      timeoutMs
    );

    ws.on('open', () => settle({ ok: true, ws, next }));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => settle({ ok: false, status: res.statusCode, body }));
    });
    ws.on('error', (err) => settle({ ok: false, status: null, error: err.message }));
  });
}

before(async () => {
  await registry.init();
  app = http.createServer(createApp());
  app.on('upgrade', proxy.handleUpgrade);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;

  // 'alpha' and 'alpha-two' deliberately share a prefix.
  await startUpstream('alpha', await createProject('alpha'));
  await startUpstream('alpha-two', await createProject('alpha-two'));
  // 'ghost' is registered but has no ttyd behind it.
  await createProject('ghost');
});

after(async () => {
  proxy.close();
  for (const u of upstreams.values()) {
    u.wss.close();
    u.server.close();
  }
  app.close();
  fs.rmSync(process.env.WEBTERM_HOME, { recursive: true, force: true });
});

test('GET /term/<slug>/ reaches ttyd with the path unmodified', async () => {
  const r = await get('/term/alpha/');
  assert.equal(r.status, 200);
  assert.match(r.text, /ttyd alpha/);
  const last = upstreams.get('alpha').seen.at(-1);
  assert.equal(last.url, '/term/alpha/', 'the /term/<slug> prefix must NOT be stripped');
});

test('sub-paths and query strings pass through', async () => {
  assert.equal((await get('/term/alpha/token')).text, '{"token":""}');
  const r = await get('/term/alpha/echo/deep?a=1&b=2');
  assert.equal(JSON.parse(r.text).url, '/term/alpha/echo/deep?a=1&b=2');
});

test('request bodies survive — the JSON parser must not consume them first', async () => {
  const r = await get('/term/alpha/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"hello":"world"}',
  });
  const echoed = JSON.parse(r.text);
  assert.equal(echoed.method, 'POST');
  assert.equal(echoed.body, '{"hello":"world"}');
});

test('streamed responses pass through intact', async () => {
  const r = await get('/term/alpha/big');
  assert.equal(r.text.length, 64 * 16 * 1024);
});

test('X-Forwarded-For is added', async () => {
  await get('/term/alpha/');
  assert.ok(upstreams.get('alpha').seen.at(-1).headers['x-forwarded-for']);
});

test('prefix-sharing slugs route to their own upstream', async () => {
  assert.match((await get('/term/alpha-two/')).text, /ttyd alpha-two/);
  assert.match((await get('/term/alpha/')).text, /ttyd alpha/);
});

test('WebSocket upgrade is proxied, with the tty subprotocol', async () => {
  const conn = await wsConnect('/term/alpha/ws', 'tty');
  assert.equal(conn.ok, true, `handshake failed: ${JSON.stringify(conn)}`);
  assert.equal(conn.ws.protocol, 'tty');
  assert.equal((await conn.next()).toString(), 'hello from alpha');

  conn.ws.send('type me');
  assert.equal((await conn.next()).toString(), 'type me');
  conn.ws.close();
});

test('WebSocket carries binary frames both ways', async () => {
  const conn = await wsConnect('/term/alpha/ws', 'tty');
  assert.equal(conn.ok, true);
  await conn.next(); // greeting
  // ttyd's framing: a leading '0' byte then raw pty bytes, including NULs.
  const payload = Buffer.from([0x30, 0x00, 0xff, 0xfe, 0x0a]);
  conn.ws.send(payload);
  assert.deepEqual(await conn.next(), payload);
  conn.ws.close();
});

test('two concurrent WebSockets stay independent', async () => {
  const [a, b] = await Promise.all([
    wsConnect('/term/alpha/ws', 'tty'),
    wsConnect('/term/alpha-two/ws', 'tty'),
  ]);
  assert.equal((await a.next()).toString(), 'hello from alpha');
  assert.equal((await b.next()).toString(), 'hello from alpha-two');
  a.ws.send('to-alpha');
  b.ws.send('to-alpha-two');
  assert.equal((await a.next()).toString(), 'to-alpha');
  assert.equal((await b.next()).toString(), 'to-alpha-two');
  a.ws.close();
  b.ws.close();
});

test('unknown slug is 404, on both HTTP and upgrade', async () => {
  const r = await get('/term/nope/');
  assert.equal(r.status, 404);
  assert.match(JSON.parse(r.text).error, /no such project/);

  const conn = await wsConnect('/term/nope/ws', 'tty');
  assert.equal(conn.ok, false);
  assert.equal(conn.status, 404);
});

test('malformed and traversal slugs are rejected before any upstream call', async () => {
  const before = upstreams.get('alpha').seen.length;
  for (const p of [
    '/term/../',
    '/term/..',
    '/term/%2e%2e/',
    '/term/..%2Falpha/',
    '/term/%2falpha/',
    '/term/ALPHA/',
    '/term/alpha%00/',
    '/term/%61lpha/', // percent-encoded 'a': the slug is matched raw, so this is not "alpha"
    '/term/al pha/', // Node's HTTP parser rejects this request line outright
    '/term/-alpha/',
    '/term/al.pha/',
    '/term/alpha.service/',
    '/term/alpha;id/',
  ]) {
    const r = await rawGet(p);
    assert.ok(
      r.status === 404 || r.status === 400,
      `${p} should be refused (400/404), got ${r.status}`
    );
  }
  assert.equal(upstreams.get('alpha').seen.length, before, 'no request reached ttyd');
});

test('a valid slug still routes when sent as a raw, unnormalised target', async () => {
  assert.match((await rawGet('/term/alpha/')).text, /ttyd alpha/);
});

test('a registered project with no ttyd behind it is 502, not a hang', async () => {
  const r = await get('/term/ghost/');
  assert.equal(r.status, 502);
  assert.match(JSON.parse(r.text).error, /systemctl --user status ttyd@ghost\.service/);

  const conn = await wsConnect('/term/ghost/ws', 'tty');
  assert.equal(conn.ok, false);
  assert.equal(conn.status, 502);
});

test('a project created after boot is routable immediately', async () => {
  const port = await createProject('late');
  await startUpstream('late', port);
  assert.match((await get('/term/late/')).text, /ttyd late/);
});

test('deleting a project stops routing to it', async () => {
  await registry.transaction((d) => {
    delete d['late'];
  });
  assert.equal((await get('/term/late/')).status, 404);
});

test('/term routing does not shadow the API or the static frontend', async () => {
  assert.equal((await get('/api/projects')).status, 200);
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/termite')).status, 404, 'prefix match must be on a path segment');
  assert.equal((await get('/term')).status, 404);
});

test('upgrade on a non-/term path is refused, not crashed', async () => {
  const conn = await wsConnect('/api/projects');
  assert.equal(conn.ok, false);
  assert.equal(conn.status, 404);
});
