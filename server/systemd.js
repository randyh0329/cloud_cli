'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { run } = require('./exec');

const TEMPLATE_NAME = 'ttyd@.service';
const MAIN_UNIT_NAME = 'webterm.service';
const USER_UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_TEMPLATE = path.join(REPO_ROOT, 'systemd', TEMPLATE_NAME);
const REPO_MAIN_UNIT = path.join(REPO_ROOT, 'systemd', MAIN_UNIT_NAME);

/**
 * `systemctl --user` talks to a per-user manager over D-Bus. A daemon started
 * outside a login session inherits neither XDG_RUNTIME_DIR nor
 * DBUS_SESSION_BUS_ADDRESS, so we reconstruct them from the uid. This is also
 * why `loginctl enable-linger` is a hard requirement: without it the user
 * manager (and /run/user/<uid>) only exists while someone is logged in.
 */
function systemctlEnv() {
  const uid = process.getuid();
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
  };
}

const unitName = (slug) => `ttyd@${slug}.service`;

function systemctl(args, opts = {}) {
  return run('systemctl', ['--user', ...args], { env: systemctlEnv(), ...opts });
}

/** Can we reach the user manager at all? */
async function probe() {
  const uid = process.getuid();
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  if (!fs.existsSync(runtimeDir)) {
    return {
      ok: false,
      reason: `${runtimeDir} does not exist — the systemd user manager is not running. Run: sudo loginctl enable-linger ${os.userInfo().username}`,
    };
  }
  let r;
  try {
    r = await systemctl(['is-system-running'], { timeout: 5000 });
  } catch (err) {
    return { ok: false, reason: `systemctl --user is not runnable: ${err.message}` };
  }
  const state = r.stdout.trim();
  // "degraded" means some unrelated unit failed; the manager is still usable.
  if (/Failed to connect|Failed to get D-Bus|refusing to operate/i.test(r.stderr)) {
    return { ok: false, reason: r.stderr.trim().split('\n')[0] };
  }
  return { ok: true, state: state || 'unknown' };
}

async function lingerEnabled() {
  const r = await run('loginctl', ['show-user', os.userInfo().username, '--property=Linger']);
  if (r.code !== 0) return false;
  return /Linger=yes/i.test(r.stdout);
}

function templateInstalled() {
  return fs.existsSync(path.join(USER_UNIT_DIR, TEMPLATE_NAME));
}

function mainUnitInstalled() {
  return fs.existsSync(path.join(USER_UNIT_DIR, MAIN_UNIT_NAME));
}

/** Write a unit body into ~/.config/systemd/user/ atomically, then reload. */
async function writeUnit(name, body, { force }) {
  const dest = path.join(USER_UNIT_DIR, name);
  const existed = fs.existsSync(dest);
  if (existed && !force) return 'present';

  await fsp.mkdir(USER_UNIT_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, body, { mode: 0o644 });
  await fsp.rename(tmp, dest);
  await systemctl(['daemon-reload']);
  return existed ? 'updated' : 'installed';
}

/**
 * Copy systemd/ttyd@.service into ~/.config/systemd/user/ and reload.
 * By default an existing file is left alone — it may have been hand-tuned
 * (ttyd path, extra flags). Pass {force:true} to overwrite.
 * @returns {Promise<'installed'|'present'|'updated'>}
 */
async function installTemplate({ force = false } = {}) {
  return writeUnit(TEMPLATE_NAME, await fsp.readFile(REPO_TEMPLATE, 'utf8'), { force });
}

/**
 * Point the shipped webterm.service at wherever this checkout actually lives.
 * The unit in git carries a placeholder path; nothing but the installer knows
 * the real one, and a wrong WorkingDirectory fails at boot with a bare
 * status=200/CHDIR that says nothing about the cause.
 * @param {string} body   contents of systemd/webterm.service
 * @param {string} root   absolute path of the checkout
 */
function renderMainUnit(body, root = REPO_ROOT) {
  const abs = path.resolve(root);
  if (!/^WorkingDirectory=/m.test(body)) {
    throw new Error(`${MAIN_UNIT_NAME} has no WorkingDirectory= line to point at ${abs}`);
  }
  // systemd reads the *last* assignment, so rewrite in place rather than
  // appending, and keep it to the one line: everything else is hand-editable.
  return body.replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${abs}`);
}

/**
 * Install webterm.service itself, with WorkingDirectory rewritten to this
 * checkout. Same overwrite rule as the template.
 * @returns {Promise<'installed'|'present'|'updated'>}
 */
async function installMainUnit({ force = false } = {}) {
  const body = renderMainUnit(await fsp.readFile(REPO_MAIN_UNIT, 'utf8'));
  return writeUnit(MAIN_UNIT_NAME, body, { force });
}

/**
 * `systemctl --user enable webterm.service` — start on boot. Deliberately not
 * `--now`: installing is not the same as taking over port 3000 from whatever
 * the operator is running right now (scripts/smoke.sh, `npm start`).
 *
 * Only actually starts at boot if lingering is on; preflight already warns
 * about that, and install.sh enables it.
 * @returns {Promise<'enabled'|'already-enabled'>}
 */
async function enableAtBoot() {
  const before = await systemctl(['is-enabled', MAIN_UNIT_NAME]);
  if (before.stdout.trim() === 'enabled') return 'already-enabled';

  const r = await systemctl(['enable', MAIN_UNIT_NAME]);
  if (r.code !== 0) {
    throw new Error(
      `systemctl --user enable ${MAIN_UNIT_NAME} failed: ${(r.stderr || r.stdout).trim()}`
    );
  }
  return 'enabled';
}

/** @returns {Promise<string>} enabled|disabled|static|not-found|... */
async function bootEnabledState() {
  const r = await systemctl(['is-enabled', MAIN_UNIT_NAME]);
  return r.stdout.trim() || 'not-found';
}

/** @returns {Promise<string>} active|inactive|failed|activating|deactivating|unknown */
async function activeState(slug) {
  const r = await systemctl(['is-active', unitName(slug)]);
  const s = r.stdout.trim();
  return s || 'unknown';
}

/**
 * One systemctl call for every project, instead of one per project.
 * @param {string[]} slugs
 * @returns {Promise<Map<string,string>>} slug -> ActiveState
 */
async function activeStates(slugs) {
  const out = new Map(slugs.map((s) => [s, 'unknown']));
  if (slugs.length === 0) return out;
  const byUnit = new Map(slugs.map((s) => [unitName(s), s]));
  const r = await systemctl([
    'show',
    ...byUnit.keys(),
    '--property=Id',
    '--property=ActiveState',
  ]);
  if (r.code !== 0 && !r.stdout.trim()) return out;

  // Output is one blank-line-separated block per unit.
  for (const block of r.stdout.split(/\n\s*\n/)) {
    const id = /^Id=(.*)$/m.exec(block)?.[1]?.trim();
    const state = /^ActiveState=(.*)$/m.exec(block)?.[1]?.trim();
    if (id && byUnit.has(id)) out.set(byUnit.get(id), state || 'unknown');
  }
  return out;
}

/** Recent journal lines for a unit — used to explain a failed start. */
async function journalTail(slug, lines = 15) {
  const r = await run(
    'journalctl',
    ['--user', '-u', unitName(slug), '-n', String(lines), '--no-pager', '-o', 'cat'],
    { env: systemctlEnv(), timeout: 5000 }
  ).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : '';
}

/**
 * enable + start the instance. Idempotent: safe on an already-running unit.
 * A previously failed unit is reset first, otherwise `enable --now` is a no-op
 * and the unit stays failed.
 */
async function enableStart(slug) {
  const unit = unitName(slug);
  const before = await activeState(slug);
  if (before === 'failed') await systemctl(['reset-failed', unit]);

  const r = await systemctl(['enable', '--now', unit]);
  if (r.code !== 0) {
    throw new Error(`systemctl --user enable --now ${unit} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return before === 'active' ? 'already-active' : 'started';
}

/** stop + disable. Tolerates the unit not existing. */
async function disableStop(slug) {
  const unit = unitName(slug);
  const r = await systemctl(['disable', '--now', unit]);
  const missing = /not loaded|does not exist|No such file/i.test(r.stderr);
  if (r.code !== 0 && !missing) {
    // Fall back to a plain stop so a broken [Install] section can't strand ttyd.
    const stop = await systemctl(['stop', unit]);
    if (stop.code !== 0 && !/not loaded|No such file/i.test(stop.stderr)) {
      throw new Error(`systemctl --user disable --now ${unit} failed: ${(r.stderr || r.stdout).trim()}`);
    }
  }
  await systemctl(['reset-failed', unit]); // ignore result
  return missing ? 'absent' : 'stopped';
}

module.exports = {
  TEMPLATE_NAME,
  MAIN_UNIT_NAME,
  USER_UNIT_DIR,
  REPO_ROOT,
  REPO_TEMPLATE,
  REPO_MAIN_UNIT,
  unitName,
  systemctl,
  systemctlEnv,
  probe,
  lingerEnabled,
  templateInstalled,
  mainUnitInstalled,
  installTemplate,
  renderMainUnit,
  installMainUnit,
  enableAtBoot,
  bootEnabledState,
  activeState,
  activeStates,
  journalTail,
  enableStart,
  disableStop,
};
