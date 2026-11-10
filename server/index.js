'use strict';

const config = require('./config');
const net = require('net');

const access = require('./access');
const auth = require('./auth');
const guard = require('./guard');
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

/**
 * Literal loopback addresses only (plus "localhost"). A hostname is not
 * resolved here, so "127.example.com" must not pass a prefix test.
 */
function isLoopback(host) {
  if (host === 'localhost') return true;
  const kind = net.isIP(host);
  if (kind === 4) return host.startsWith('127.');
  if (kind === 6) return host === '::1';
  return false;
}

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

/** Half an Access configuration would silently verify nothing — refuse it. */
function assertAccessConfig() {
  if (!access.halfConfigured()) return;
  console.error(
    'fatal: set both WEBTERM_ACCESS_TEAM and WEBTERM_ACCESS_AUD to verify Cloudflare ' +
      'Access tokens, or neither.'
  );
  process.exit(1);
}

async function main() {
  if (process.argv.includes('--install-units')) return installUnitsAndExit();

  assertBindIsSafe();
  assertAccessConfig();
  if (access.enabled()) {
    // Warm the key cache; on failure requests are refused (fail closed) and the
    // fetch is retried on demand.
    await access.refreshKeys({ force: true }).catch((err) => {
      console.error(`  ERROR  could not load Cloudflare Access keys from ${access.certsUrl()}: ${err.message}`);
    });
  }

  const loaded = await registry.init();
  const app = createApp();

  const pf = await supervisor.preflight({ fresh: true });

  // Express never sees upgrade requests; wire the WebSocket leg onto the
  // http.Server directly.
  const server = app.listen(config.LISTEN_PORT, config.LISTEN_HOST, () => {
    console.log(`webterm listening on http://${config.LISTEN_HOST}:${config.LISTEN_PORT}`);
    console.log(`  state dir:       ${config.WEBTERM_HOME}`);
    console.log(`  projects loaded: ${Object.keys(loaded).length}`);
    const methods = [
      access.enabled() && 'Cloudflare Access JWT verified',
      auth.enabled() && 'dev password',
    ].filter(Boolean);
    console.log(`  auth:            ${methods.join(' + ') || 'none in-app (relies on Cloudflare Access in front)'}`);
    if (!access.enabled() && !auth.enabled()) {
      console.warn(
        '  warn   Access tokens are not verified. Set WEBTERM_ACCESS_TEAM and WEBTERM_ACCESS_AUD\n' +
          '         so a missing or misconfigured Access application fails closed.'
      );
    }
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

  // Same gates, same order, as the Express path in app.js.
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    if (!(await access.authorizeUpgrade(req, socket))) return;
    if (!auth.authorizeUpgrade(req, socket)) return;
    if (!guard.authorizeUpgrade(req, socket)) return;
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
