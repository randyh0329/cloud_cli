'use strict';

const { run } = require('./exec');

const TMUX = process.env.WEBTERM_TMUX_BIN || 'tmux';

// tmux target resolution does prefix and fnmatch matching by default, so a bare
// `-t alpha` can resolve to a session named `alpha-two`. Prefixing with '='
// forces an exact match.
//
// The two target types need different spellings, verified against tmux 3.5a:
//   target-session (has-session, kill-session)  ->  "=slug"
//   target-pane    (send-keys, capture-pane)    ->  "=slug:"   ("=slug" errors
//                                                   with "can't find pane")
const sessionTarget = (slug) => `=${slug}`;
const paneTarget = (slug) => `=${slug}:`;

/**
 * A tmux server exits as soon as its last session closes, so "server is up" is
 * equivalent to "at least one session exists".
 */
async function serverRunning() {
  const r = await run(TMUX, ['list-sessions', '-F', '#{session_name}']);
  return r.code === 0;
}

async function hasSession(slug) {
  const r = await run(TMUX, ['has-session', '-t', sessionTarget(slug)]);
  return r.code === 0;
}

/** @returns {Promise<string[]>} names of all live sessions */
async function listSessions() {
  const r = await run(TMUX, ['list-sessions', '-F', '#{session_name}']);
  if (r.code !== 0) return []; // no server running => no sessions
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Create a detached session named <slug> rooted at <cwd>, if absent.
 *
 * The very first session also starts the tmux *server*, and the server inherits
 * the cgroup of whoever spawned it. If that were webterm.service, restarting
 * the Node app would kill every project's shell; if it were ttyd@<slug>, then
 * deleting one project would kill all the others. So the first session is
 * launched inside a transient systemd scope, which outlives both.
 *
 * @returns {Promise<'created'|'created-in-scope'|'exists'>}
 */
async function ensureSession(slug, cwd) {
  if (await hasSession(slug)) return 'exists';

  const argv = ['new-session', '-d', '-s', slug, '-c', cwd];
  const needsScope = !(await serverRunning());

  let r;
  let how = 'created';
  if (needsScope) {
    r = await run('systemd-run', [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--unit=webterm-tmux-server`,
      '--',
      TMUX,
      ...argv,
    ]).catch((err) => ({ code: 127, stdout: '', stderr: err.message }));
    if (r.code === 0) {
      how = 'created-in-scope';
    } else {
      console.warn(
        `[tmux] could not start the tmux server in a systemd scope (${(r.stderr || '').trim().split('\n')[0]}); ` +
          'falling back to a plain spawn. The tmux server will share this process\'s cgroup, ' +
          'so restarting webterm will kill running sessions.'
      );
      r = null;
    }
  }

  if (r === null || !needsScope) {
    r = await run(TMUX, argv);
    how = 'created';
  }

  if (r.code === 0) return how;
  // Lost a race with ttyd's own `tmux new -A`, or with a concurrent request.
  if (/duplicate session/i.test(r.stderr) || (await hasSession(slug))) return 'exists';
  throw new Error(`tmux new-session failed for "${slug}": ${(r.stderr || r.stdout).trim()}`);
}

/** @returns {Promise<'killed'|'absent'>} */
async function killSession(slug) {
  if (!(await hasSession(slug))) return 'absent';
  const r = await run(TMUX, ['kill-session', '-t', sessionTarget(slug)]);
  if (r.code === 0) return 'killed';
  if (!(await hasSession(slug))) return 'absent';
  throw new Error(`tmux kill-session failed for "${slug}": ${(r.stderr || r.stdout).trim()}`);
}

/**
 * Type `text` into the session's active pane.
 *
 * `-l` sends the string literally. Without it tmux resolves each argument as a
 * key *name* first, so a payload of "Enter" would submit the line and "C-c"
 * would interrupt. `--` stops a leading '-' being parsed as a flag.
 */
async function sendKeysLiteral(slug, text) {
  if (!(await hasSession(slug))) {
    throw Object.assign(new Error(`tmux session "${slug}" is not running`), { noSession: true });
  }
  const r = await run(TMUX, ['send-keys', '-t', paneTarget(slug), '-l', '--', text]);
  if (r.code !== 0) {
    throw new Error(`tmux send-keys failed for "${slug}": ${(r.stderr || r.stdout).trim()}`);
  }
}

/** Visible contents of a session's active pane — used by tests. */
async function capturePane(slug) {
  const r = await run(TMUX, ['capture-pane', '-p', '-t', paneTarget(slug)]);
  return r.code === 0 ? r.stdout : null;
}

async function version() {
  const r = await run(TMUX, ['-V']).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : null;
}

module.exports = {
  TMUX,
  serverRunning,
  hasSession,
  listSessions,
  ensureSession,
  killSession,
  sendKeysLiteral,
  capturePane,
  version,
};
