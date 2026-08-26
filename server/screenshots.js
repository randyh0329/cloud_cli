'use strict';

/**
 * Paste-to-screenshot (spec §3.5).
 *
 * Save a pasted image under the project's screenshot directory, then type its
 * absolute path into that project's tmux pane — with a trailing space and no
 * Enter, so the path lands at the cursor and the rest of the prompt can be
 * typed around it.
 */

const fsp = require('fs').promises;
const path = require('path');

const config = require('./config');
const registry = require('./registry');
const supervisor = require('./supervisor');
const { assertSlug } = require('./slug');
const { badRequest, notFound, HttpError } = require('./errors');

/**
 * Identify the image from its bytes, not from the declared Content-Type or the
 * client-supplied filename — both are attacker-controlled and neither decides
 * what actually lands on disk.
 */
const SIGNATURES = [
  { ext: 'png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', test: (b) => b.length > 6 && b.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/) },
  {
    ext: 'webp',
    test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

function sniff(buffer) {
  for (const sig of SIGNATURES) if (sig.test(buffer)) return sig.ext;
  return null;
}

/**
 * ISO 8601 with the colons and dot swapped for hyphens: the timestamp stays
 * sortable and readable, but the filename is safe to type unquoted in a shell
 * and legal on filesystems that reject ':'.
 */
function timestampName(ext, now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, '-')}.${ext}`;
}

// Characters a POSIX shell (and Claude Code's path detection) leave alone.
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuote(str) {
  if (SHELL_SAFE.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/**
 * Where this project's screenshots go.
 *
 * The registry records a `screenshot_dir`, but projects.json is a file on disk
 * that could be hand-edited, so a path outside the screenshots root is refused
 * and the canonical location used instead.
 */
function screenshotDir(slug, entry) {
  const canonical = path.join(config.SCREENSHOTS_DIR, slug);
  const recorded = entry && entry.screenshot_dir ? path.resolve(entry.screenshot_dir) : null;
  if (!recorded) return canonical;
  const root = config.SCREENSHOTS_DIR + path.sep;
  if (recorded !== canonical && !recorded.startsWith(root)) {
    console.warn(
      `[screenshots] registry screenshot_dir for "${slug}" (${recorded}) is outside ` +
        `${config.SCREENSHOTS_DIR}; using ${canonical} instead`
    );
    return canonical;
  }
  return recorded;
}

/** Write the buffer under a fresh name, never clobbering an existing file. */
async function writeUnique(dir, ext) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = attempt === 0 ? timestampName(ext) : timestampName(ext).replace(/\.(\w+)$/, `-${attempt}.$1`);
    const dest = path.join(dir, name);
    try {
      // 'wx' fails if the name is taken, so two pastes in the same millisecond
      // cannot overwrite each other.
      const fh = await fsp.open(dest, 'wx', 0o600);
      return { dest, name, fh };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new HttpError(500, 'could not find a free screenshot filename');
}

/**
 * @param {object} args
 * @param {string} args.project  slug from the multipart body
 * @param {{buffer: Buffer, size: number, mimetype: string}} [args.file]
 */
async function upload({ project, file }) {
  const slug = assertSlug(project);
  const entry = registry.get(slug);
  if (!entry) throw notFound(`no such project: ${slug}`);

  if (!file || !file.buffer || file.buffer.length === 0) {
    throw badRequest('expected a non-empty "file" part containing an image');
  }
  const ext = sniff(file.buffer);
  if (!ext) {
    throw badRequest(
      `"file" is not a recognised image (got ${file.buffer.length} bytes, declared ` +
        `${file.mimetype || 'no type'}); expected PNG, JPEG, GIF or WebP`
    );
  }

  const dir = screenshotDir(slug, entry);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  const { dest, name, fh } = await writeUnique(dir, ext);
  try {
    await fh.writeFile(file.buffer);
  } finally {
    await fh.close();
  }

  // The file is saved either way; a dead tmux session is reported, not thrown,
  // so the path is still returned and the paste is not silently lost.
  let injected = true;
  let warning;
  try {
    await supervisor.inject({ slug, text: `${shellQuote(dest)} ` });
  } catch (err) {
    injected = false;
    warning = err.noSession
      ? `saved, but tmux session "${slug}" is not running — nothing was typed`
      : `saved, but could not type the path into "${slug}": ${err.message}`;
    console.warn(`[screenshots] ${warning}`);
  }

  return { project: slug, path: dest, filename: name, bytes: file.buffer.length, injected, warning };
}

module.exports = { upload, _sniff: sniff, _shellQuote: shellQuote, _screenshotDir: screenshotDir };
