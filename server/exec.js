'use strict';

const { execFile } = require('child_process');

/**
 * Run a command with an argv array. Never goes through a shell, so slugs and
 * paths cannot be interpreted as shell metacharacters even if validation is
 * ever loosened.
 *
 * Resolves with {code, stdout, stderr} for *any* exit status; only spawn
 * failures (ENOENT, timeout) reject. Callers decide what a non-zero code means,
 * because for systemctl/tmux "failure" is frequently the expected answer.
 */
function run(file, args, opts = {}) {
  const { timeout = 15000, env, cwd } = opts;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, env, cwd, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err && typeof err.code === 'string') {
          // spawn-level failure: ENOENT, EACCES, ETIMEDOUT...
          reject(
            Object.assign(new Error(`${file}: ${err.code} (${err.message})`), {
              spawnError: err.code,
              file,
            })
          );
          return;
        }
        resolve({
          code: err ? (err.code ?? 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      }
    );
  });
}

/** Like run(), but a non-zero exit throws. */
async function runOk(file, args, opts) {
  const r = await run(file, args, opts);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n');
    throw Object.assign(new Error(`${file} ${args.join(' ')} exited ${r.code}: ${detail}`), {
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }
  return r;
}

module.exports = { run, runOk };
