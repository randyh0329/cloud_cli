'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');

process.env.WEBTERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-api-'));
// Exercise the HTTP/registry layer without touching tmux or systemd; the real
// supervisor has its own integration tests in tmux.test.js.
process.env.WEBTERM_STUB_SUPERVISOR = '1';

const registry = require('../server/registry');
const config = require('../server/config');
const { createApp } = require('../server/app');

let server;
let base;

async function req(method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON response (e.g. static html) */
  }
  return { status: res.status, json, text };
}

before(async () => {
  await registry.init();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(config.WEBTERM_HOME, { recursive: true, force: true });
});

test('GET /api/projects is empty initially', async () => {
  const r = await req('GET', '/api/projects');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.projects, []);
});

test('POST /api/projects creates a project', async () => {
  const r = await req('POST', '/api/projects', { slug: 'alpha' });
  assert.equal(r.status, 201);
  assert.equal(r.json.slug, 'alpha');
  assert.equal(r.json.port, config.PORT_BASE);
  assert.equal(r.json.cwd, os.homedir());
  assert.equal(r.json.url, '/term/alpha/');
  assert.equal(r.json.screenshot_dir, path.join(config.SCREENSHOTS_DIR, 'alpha'));
  assert.ok(fs.statSync(r.json.screenshot_dir).isDirectory(), 'screenshot dir created');
});

test('POST with an explicit cwd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const r = await req('POST', '/api/projects', { slug: 'beta', cwd: dir });
  assert.equal(r.status, 201);
  assert.equal(r.json.cwd, dir);
  assert.equal(r.json.port, config.PORT_BASE + 1);
});

test('duplicate slug is 409', async () => {
  const r = await req('POST', '/api/projects', { slug: 'alpha' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already exists/);
});

test('bad slugs are 400 and never create anything', async () => {
  for (const slug of ['../evil', 'Foo', 'a b', 'foo;id', '', 'x'.repeat(40), 'foo.service']) {
    const r = await req('POST', '/api/projects', { slug });
    assert.equal(r.status, 400, `slug ${JSON.stringify(slug)} should be rejected`);
  }
  const list = await req('GET', '/api/projects');
  assert.deepEqual(
    list.json.projects.map((p) => p.slug),
    ['alpha', 'beta']
  );
});

test('bad cwd is 400', async () => {
  assert.equal((await req('POST', '/api/projects', { slug: 'g1', cwd: 'relative' })).status, 400);
  assert.equal((await req('POST', '/api/projects', { slug: 'g2', cwd: '/no/such/dir' })).status, 400);
  assert.equal(
    (await req('POST', '/api/projects', { slug: 'g3', cwd: '/etc/hostname' })).status,
    400
  );
});

test('GET one project, and 404 for unknown', async () => {
  assert.equal((await req('GET', '/api/projects/alpha')).json.slug, 'alpha');
  assert.equal((await req('GET', '/api/projects/nope')).status, 404);
  // a traversal attempt is a validation error, not a filesystem read
  assert.equal((await req('GET', '/api/projects/..%2F..%2Fetc')).status, 400);
});

test('registry survives a restart', async () => {
  const snap = await registry.init();
  assert.deepEqual(Object.keys(snap).sort(), ['alpha', 'beta']);
  const r = await req('GET', '/api/projects');
  assert.deepEqual(
    r.json.projects.map((p) => p.slug),
    ['alpha', 'beta']
  );
});

test('DELETE removes the entry, keeps screenshots, frees the port', async () => {
  const dir = path.join(config.SCREENSHOTS_DIR, 'alpha');
  fs.writeFileSync(path.join(dir, 'keep.png'), 'x');

  const r = await req('DELETE', '/api/projects/alpha');
  assert.equal(r.status, 200);
  assert.equal(r.json.removed, true);
  assert.ok(fs.existsSync(path.join(dir, 'keep.png')), 'screenshots are not deleted');

  assert.equal((await req('DELETE', '/api/projects/alpha')).status, 404);

  const again = await req('POST', '/api/projects', { slug: 'gamma' });
  assert.equal(again.json.port, config.PORT_BASE, 'freed port is reused');
});

test('unknown routes 404 as JSON', async () => {
  const r = await req('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
});

test('static frontend is served at /', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<html/);
});
