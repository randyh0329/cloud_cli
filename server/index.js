'use strict';

const config = require('./config');
const registry = require('./registry');
const supervisor = require('./supervisor');
const systemd = require('./systemd');
const { createApp } = require('./app');

async function installUnitsAndExit() {
  const how = await systemd.installTemplate({ force: true });
  console.log(`${systemd.TEMPLATE_NAME} ${how} in ${systemd.USER_UNIT_DIR}`);
  const pf = await supervisor.preflight({ fresh: true });
  for (const p of pf.problems) console.log(`  ${p.fatal ? 'ERROR' : 'warn '}  ${p.message}`);
  process.exit(pf.ok ? 0 : 1);
}

async function main() {
  if (process.argv.includes('--install-units')) return installUnitsAndExit();

  const loaded = await registry.init();
  const app = createApp();

  const pf = await supervisor.preflight({ fresh: true });

  const server = app.listen(config.LISTEN_PORT, config.LISTEN_HOST, () => {
    console.log(`webterm listening on http://${config.LISTEN_HOST}:${config.LISTEN_PORT}`);
    console.log(`  state dir:       ${config.WEBTERM_HOME}`);
    console.log(`  projects loaded: ${Object.keys(loaded).length}`);
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

  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down`);
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
