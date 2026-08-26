'use strict';

const os = require('os');
const path = require('path');

// Root for all mutable state this app owns. Override with WEBTERM_HOME for tests.
const WEBTERM_HOME = path.resolve(
  process.env.WEBTERM_HOME || path.join(os.homedir(), 'webterm')
);

module.exports = {
  WEBTERM_HOME,
  REGISTRY_FILE: path.join(WEBTERM_HOME, 'projects.json'),
  SCREENSHOTS_DIR: path.join(WEBTERM_HOME, 'screenshots'),
  // One <slug>.env per project, read by ttyd@.service via EnvironmentFile.
  ENV_DIR: path.join(WEBTERM_HOME, 'env'),

  // ttyd port pool. Ports are allocated lowest-free-first and released on delete.
  PORT_BASE: Number(process.env.WEBTERM_PORT_BASE || 7681),
  PORT_COUNT: Number(process.env.WEBTERM_PORT_COUNT || 100),

  // The Node app itself. Bound to loopback only: cloudflared is the sole ingress.
  LISTEN_HOST: '127.0.0.1',
  LISTEN_PORT: Number(process.env.PORT || 3000),

  DEFAULT_CWD: os.homedir(),

  // Largest pasted image accepted. A screenshot of a 4K display is ~5 MB.
  MAX_UPLOAD_BYTES: Number(process.env.WEBTERM_MAX_UPLOAD_BYTES || 12 * 1024 * 1024),

  // Set truthy to skip all tmux/systemd side effects (milestone-1 behaviour).
  STUB_SUPERVISOR: process.env.WEBTERM_STUB_SUPERVISOR === '1',
};
