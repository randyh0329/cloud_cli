'use strict';

/**
 * The injection half of paste-to-screenshot, against a real tmux session.
 *
 * This file deliberately does NOT set WEBTERM_STUB_SUPERVISOR: it exercises
 * server/screenshots.js -> supervisor.inject -> tmux send-keys for real. Only
 * tmux is needed — no ttyd, no systemd.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after, describe } = require('node:test');
const { execFileSync } = require('node:child_process');

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-inject-'));
process.env.WEBTERM_HOME = TMPROOT;
// Isolate from the developer's own tmux server.
process.env.TMUX_TMPDIR = TMPROOT;

let haveTmux = true;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
} catch {
  haveTmux = false;
}

const config = require('../server/config');
const registry = require('../server/registry');
const tmux = require('../server/tmux');
const screenshots = require('../server/screenshots');

const SLUG = 'shotproj';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('a small fake png body'),
]);

const flat = (s) => (s || '').replace(/\n/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('screenshot injection', { skip: haveTmux ? false : 'tmux is not installed' }, () => {
  before(async () => {
    await registry.init();
    await registry.transaction((d) => {
      d[SLUG] = {
        port: 7681,
        cwd: TMPROOT,
        created_at: new Date().toISOString(),
        screenshot_dir: path.join(config.SCREENSHOTS_DIR, SLUG),
      };
    });
    await tmux.ensureSession(SLUG, TMPROOT);
    // A wide window keeps the typed path on one captured line.
    await require('../server/exec').run('tmux', ['resize-window', '-t', `=${SLUG}:`, '-x', '240', '-y', '50']);
    await sleep(400); // let the shell draw its prompt first
  });

  after(async () => {
    await tmux.killSession(SLUG).catch(() => {});
    fs.rmSync(TMPROOT, { recursive: true, force: true });
  });

  test('the path is typed into the pane and left unexecuted', async () => {
    const result = await screenshots.upload({
      project: SLUG,
      file: { buffer: PNG, size: PNG.length, mimetype: 'image/png' },
    });

    assert.equal(result.injected, true);
    assert.equal(result.warning, undefined);
    assert.equal(fs.existsSync(result.path), true);

    await sleep(300);
    const pane = await tmux.capturePane(SLUG);
    assert.ok(pane !== null, 'capture-pane returned nothing');
    assert.ok(
      flat(pane).includes(result.path),
      `expected the path on the command line, got:\n${pane}`
    );
    // If Enter had been sent, the shell would have tried to run the PNG.
    assert.doesNotMatch(pane, /command not found|Permission denied|cannot execute/i);
  });

  test('a second paste appends to the same unsubmitted line', async () => {
    const first = flat(await tmux.capturePane(SLUG));
    const result = await screenshots.upload({
      project: SLUG,
      file: { buffer: PNG, size: PNG.length, mimetype: 'image/png' },
    });
    await sleep(300);

    const pane = flat(await tmux.capturePane(SLUG));
    assert.ok(pane.includes(result.path), 'the second path was typed too');
    assert.ok(
      pane.length > first.length,
      'the line grew rather than being replaced — the first paste was never submitted'
    );
  });

  test('a project whose session has died reports it instead of losing the file', async () => {
    await registry.transaction((d) => {
      d['gone'] = {
        port: 7682,
        cwd: TMPROOT,
        created_at: new Date().toISOString(),
        screenshot_dir: path.join(config.SCREENSHOTS_DIR, 'gone'),
      };
    });

    const result = await screenshots.upload({
      project: 'gone',
      file: { buffer: PNG, size: PNG.length, mimetype: 'image/png' },
    });

    assert.equal(result.injected, false);
    assert.match(result.warning, /is not running/);
    assert.equal(fs.existsSync(result.path), true, 'the screenshot is still saved');
  });

  test('a session named like a prefix of ours is never typed into', async () => {
    // `-t shotproj` would prefix-match `shotproj-decoy`; `=shotproj:` must not.
    await tmux.ensureSession(`${SLUG}-decoy`, TMPROOT);
    await sleep(300);
    const decoyBefore = await tmux.capturePane(`${SLUG}-decoy`);

    const result = await screenshots.upload({
      project: SLUG,
      file: { buffer: PNG, size: PNG.length, mimetype: 'image/png' },
    });
    await sleep(300);

    assert.ok(flat(await tmux.capturePane(SLUG)).includes(result.path));
    assert.equal(
      flat(await tmux.capturePane(`${SLUG}-decoy`)),
      flat(decoyBefore),
      'the decoy session received nothing'
    );
    await tmux.killSession(`${SLUG}-decoy`);
  });
});
