'use strict';

const config = require('./config');
const auth = require('./auth');
const registry = require('./registry');
const supervisor = require('./supervisor');
const systemd = require('./systemd');
const proxy = require('./proxy');
const { createApp } = require('./app');

/**
 * Sync both units into ~/.config/systemd/user/. `--enable` additionally makes
 * webterm.service start at boot; it is opt-in because installing the unit and
 * handing the host's port 3000 to it on next boot are separate decisions —
 * scripts/smoke.sh installs units and would rather webterm stayed off.
 */
async function installUnitsAndExit() {
  const enable = process.argv.includes('--enable');

  const template = await systemd.installTemplate({ force: true });
  console.log(`${systemd.TEMPLATE_NAME} ${template} in ${systemd.USER_UNIT_DIR}`);

  const main = await systemd.installMainUnit({ force: true });
  console.log(
    `${systemd.MAIN_UNIT_NAME} ${main} in ${systemd.USER_UNIT_DIR} ` +
      `(WorkingDirectory=${systemd.REPO_ROOT})`
  );

  if (enable) {
    const how = await systemd.enableAtBoot();
    console.log(`${systemd.MAIN_UNIT_NAME} ${how} at boot`);
  } else {
    console.log(
      `${systemd.MAIN_UNIT_NAME} is ${await systemd.bootEnabledState()} at boot ` +
        `— re-run with --enable, or: systemctl --user enable ${systemd.MAIN_UNIT_NAME}`
    );
  }

  const pf = await supervisor.preflight({ fresh: true });
  for (const p of pf.problems) console.log(`  ${p.fatal ? 'ERROR' : 'warn '}  ${p.message}`);
  process.exit(pf.ok ? 0 : 1);
}

const isLoopback = (host) =>
  host === '127.0.0.1' || host === '::1' || host === 'localhost' || /^127\./.test(host);

/**
 * The one interlock that matters: binding anything but loopback puts a shell
 * on the network, so it requires a password to have been set deliberately.
 * Refusing to start is the right failure — a warning would be read once and a
 * running open shell would outlive it.
 */
function assertBindIsSafe() {
  if (isLoopback(config.LISTEN_HOST) || auth.enabled()) return;
  console.error(
    `fatal: WEBTERM_BIND=${config.LISTEN_HOST} exposes an interactive shell beyond ` +
      'loopback, but WEBTERM_DEV_PASSWORD is not set.\n' +
      '       Set a password, or drop WEBTERM_BIND and reach webterm through ' +
      'cloudflared as the spec intends.'
  );
  process.exit(1);
}

async function main() {
  if (process.argv.includes('--install-units')) return installUnitsAndExit();

  assertBindIsSafe();

  const loaded = await registry.init();
  const app = createApp();

  const pf = await supervisor.preflight({ fresh: true });

  // Express never sees upgrade requests; wire the WebSocket leg onto the
  // http.Server directly.
  const server = app.listen(config.LISTEN_PORT, config.LISTEN_HOST, () => {
    console.log(`webterm listening on http://${config.LISTEN_HOST}:${config.LISTEN_PORT}`);
    console.log(`  state dir:       ${config.WEBTERM_HOME}`);
    console.log(`  projects loaded: ${Object.keys(loaded).length}`);
    console.log(`  auth:            ${auth.enabled() ? 'dev password' : 'none (loopback only)'}`);
    if (!isLoopback(config.LISTEN_HOST)) {
      console.warn(
        `  WARNING: bound to ${config.LISTEN_HOST} — this shell is reachable from the network,\n` +
          '           over plain HTTP, behind one shared password. Firewall it to your own\n' +
          '           address and stop the service when the test is done.'
      );
    }
    if (supervisor.isStub()) {
      console.warn(
        '  WARNING: WEBTERM_STUB_SUPERVISOR=1 — no tmux sessions or systemd units\n' +
          '           will be created. Projects are registry entries only.'
      );
      return;
    }
    console.log(`  tmux:            ${pf.tmux || 'MISSING'} ${pf.tmux_version || ''}`);
    console.log(`  ttyd:            ${pf.ttyd || 'MISSING'}`);
    console.log(`  systemd --user:  ${pf.systemd_user || 'UNREACHABLE'} (linger: ${pf.linger})`);
    for (const p of pf.problems) {
      console[p.fatal ? 'error' : 'warn'](`  ${p.fatal ? 'ERROR' : 'warn '}  ${p.message}`);
    }
    if (!pf.ok) {
      console.error('  -> project create/delete will return 503 until the errors above are fixed');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    if (!auth.authorizeUpgrade(req, socket)) return;
    proxy.handleUpgrade(req, socket, head);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down`);
    proxy.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
