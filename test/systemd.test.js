'use strict';

/**
 * Unit-file rendering only — no systemctl, no writes to ~/.config. The one
 * thing that has to be right here is WorkingDirectory: get it wrong and
 * webterm.service fails at boot with a bare status=200/CHDIR that names
 * neither the path it tried nor the unit that supplied it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const systemd = require('../server/systemd');

const shipped = () => fs.readFileSync(systemd.REPO_MAIN_UNIT, 'utf8');

test('the shipped webterm.service has a WorkingDirectory to rewrite', () => {
  const lines = shipped().split('\n').filter((l) => /^WorkingDirectory=/.test(l));
  assert.equal(lines.length, 1, 'exactly one WorkingDirectory= line');
});

test('renderMainUnit points the unit at the given checkout', () => {
  const out = systemd.renderMainUnit(shipped(), '/srv/apps/cloud_cli');
  assert.match(out, /^WorkingDirectory=\/srv\/apps\/cloud_cli$/m);
  assert.doesNotMatch(out, /\/path\/to\/cloud_cli/);
});

test('renderMainUnit defaults to this checkout', () => {
  const out = systemd.renderMainUnit(shipped());
  assert.match(out, new RegExp(`^WorkingDirectory=${systemd.REPO_ROOT}$`, 'm'));
  assert.equal(systemd.REPO_ROOT, path.resolve(__dirname, '..'));
});

test('renderMainUnit absolutises and does not leave a second assignment', () => {
  const out = systemd.renderMainUnit(shipped(), `${systemd.REPO_ROOT}/./`);
  const found = out.split('\n').filter((l) => l.startsWith('WorkingDirectory='));
  assert.deepEqual(found, [`WorkingDirectory=${systemd.REPO_ROOT}`]);
});

test('renderMainUnit keeps the rest of the unit intact', () => {
  const before = shipped();
  const out = systemd.renderMainUnit(before, '/tmp/elsewhere');
  assert.equal(out.split('\n').length, before.split('\n').length);
  for (const keep of ['[Install]', 'WantedBy=default.target', 'ExecStart=', 'Environment=PORT=']) {
    assert.ok(out.includes(keep), `${keep} survived the rewrite`);
  }
});

test('renderMainUnit refuses a unit with nothing to rewrite', () => {
  assert.throws(
    () => systemd.renderMainUnit('[Service]\nExecStart=/bin/true\n', '/tmp/x'),
    /WorkingDirectory/
  );
});

test('a rendered unit is what install would write for the ttyd template too', () => {
  // The template is copied verbatim — no substitution — so guard the property
  // renderMainUnit relies on: %i/%h expansion is systemd's job, not ours.
  const tpl = fs.readFileSync(systemd.REPO_TEMPLATE, 'utf8');
  assert.match(tpl, /EnvironmentFile=%h\/webterm\/env\/%i\.env/);
});
