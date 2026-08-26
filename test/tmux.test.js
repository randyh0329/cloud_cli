'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');

// Isolate from the developer's real tmux server.
const TMUX_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-tmux-'));
process.env.TMUX_TMPDIR = TMUX_TMPDIR;
process.env.WEBTERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-th-'));

const tmux = require('../server/tmux');
const supervisor = require('../server/supervisor');
const { run } = require('../server/exec');

const SESSIONS = ['alpha', 'alpha-two'];

before(async () => {
  assert.ok(await tmux.version(), 'tmux must be installed to run these tests');
});

after(async () => {
  await run('tmux', ['kill-server']).catch(() => {});
  fs.rmSync(TMUX_TMPDIR, { recursive: true, force: true });
  fs.rmSync(process.env.WEBTERM_HOME, { recursive: true, force: true });
});

test('no server means no sessions, and no crash', async () => {
  assert.equal(await tmux.serverRunning(), false);
  assert.deepEqual(await tmux.listSessions(), []);
  assert.equal(await tmux.hasSession('alpha'), false);
});

test('ensureSession creates, and is idempotent', async () => {
  const first = await tmux.ensureSession('alpha', '/tmp');
  assert.ok(['created', 'created-in-scope'].includes(first), `got ${first}`);
  assert.equal(await tmux.ensureSession('alpha', '/tmp'), 'exists');
  assert.equal(await tmux.hasSession('alpha'), true);
  assert.deepEqual(await tmux.listSessions(), ['alpha']);
});

test('session honours the requested cwd', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-')));
  await tmux.ensureSession('cwdtest', dir);
  const r = await run('tmux', [
    'display-message',
    '-p',
    '-t',
    '=cwdtest:',
    '#{pane_current_path}',
  ]);
  assert.equal(fs.realpathSync(r.stdout.trim()), dir);
  await tmux.killSession('cwdtest');
});

test('targets are exact — a prefix-sharing session is never touched', async () => {
  await tmux.ensureSession('alpha-two', '/tmp');
  assert.deepEqual((await tmux.listSessions()).sort(), SESSIONS);

  await tmux.sendKeysLiteral('alpha', 'PAYLOAD-A ');
  await new Promise((r) => setTimeout(r, 300));

  assert.match(await tmux.capturePane('alpha'), /PAYLOAD-A/);
  assert.doesNotMatch(await tmux.capturePane('alpha-two'), /PAYLOAD-A/);
});

test('send-keys -l types key names instead of executing them', async () => {
  // Without -l, tmux would resolve "Enter" to the Return key and submit the
  // line; the point of the flag is that this text just appears at the cursor.
  await tmux.sendKeysLiteral('alpha-two', 'Enter C-c q ');
  await new Promise((r) => setTimeout(r, 300));
  const pane = await tmux.capturePane('alpha-two');
  assert.match(pane, /Enter C-c q/);
  // A submitted line would have produced a shell error and a fresh prompt.
  assert.doesNotMatch(pane, /command not found/);
});

test('send-keys on a dead session reports noSession rather than hanging', async () => {
  await assert.rejects(() => tmux.sendKeysLiteral('ghost', 'x'), (err) => err.noSession === true);
});

test('killSession is idempotent', async () => {
  assert.equal(await tmux.killSession('alpha'), 'killed');
  assert.equal(await tmux.killSession('alpha'), 'absent');
  assert.equal(await tmux.hasSession('alpha'), false);
  assert.equal(await tmux.hasSession('alpha-two'), true, 'killing alpha must not kill alpha-two');
});

test('envQuote produces systemd-safe values and rejects newlines', () => {
  assert.equal(supervisor._envQuote('/home/x/p'), '"/home/x/p"');
  assert.equal(supervisor._envQuote('/home/x/my project'), '"/home/x/my project"');
  assert.equal(supervisor._envQuote('/a/"b"'), '"/a/\\"b\\""');
  assert.equal(supervisor._envQuote('/a/$b`c`'), '"/a/\\$b\\`c\\`"');
  assert.throws(() => supervisor._envQuote('/a\nExecStart=/bin/sh'), /newlines/);
});

test('the ttyd bind interface accepts a name or an address, and nothing else', () => {
  const ok = supervisor._assertIface;
  assert.equal(ok('127.0.0.1'), '127.0.0.1');
  assert.equal(ok('lo'), 'lo');
  assert.equal(ok('::1'), '::1');
  assert.throws(() => ok('lo -p 22'), /not an interface name/);
  assert.throws(() => ok('0.0.0.0 --writable'), /not an interface name/);
  assert.throws(() => ok(''), /not an interface name/);
});

test('portInUse detects a bound loopback port', async () => {
  const net = require('node:net');
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  assert.equal(await supervisor._portInUse(port), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await supervisor._portInUse(port), false);
});

test('preflight reports missing prerequisites without throwing', async () => {
  const pf = await supervisor.preflight({ fresh: true });
  assert.equal(typeof pf.ok, 'boolean');
  assert.ok(pf.tmux, 'tmux should be found');
  assert.ok(Array.isArray(pf.problems));
  for (const p of pf.problems) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.message, 'string');
  }
});
