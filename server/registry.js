'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const config = require('./config');
const { isValidSlug } = require('./slug');

let cache = null;
// Serialises every read-modify-write so two concurrent POSTs can't allocate the
// same port or clobber each other's registry entry.
let queue = Promise.resolve();

async function ensureDirs() {
  await fsp.mkdir(config.WEBTERM_HOME, { recursive: true, mode: 0o700 });
  await fsp.mkdir(config.SCREENSHOTS_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(config.ENV_DIR, { recursive: true, mode: 0o700 });
}

function sanitiseLoaded(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [slug, entry] of Object.entries(raw)) {
    // Drop anything that would not survive validation today — a hand-edited or
    // older registry must never smuggle a bad slug into a shell/unit name.
    if (!isValidSlug(slug)) {
      console.warn(`[registry] dropping entry with invalid slug: ${JSON.stringify(slug)}`);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (!Number.isInteger(entry.port)) continue;
    out[slug] = {
      port: entry.port,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : config.DEFAULT_CWD,
      created_at: typeof entry.created_at === 'string' ? entry.created_at : new Date(0).toISOString(),
      screenshot_dir:
        typeof entry.screenshot_dir === 'string'
          ? entry.screenshot_dir
          : path.join(config.SCREENSHOTS_DIR, slug),
    };
  }
  return out;
}

async function loadFromDisk() {
  try {
    const text = await fsp.readFile(config.REGISTRY_FILE, 'utf8');
    return sanitiseLoaded(JSON.parse(text));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    if (err instanceof SyntaxError) {
      throw new Error(
        `${config.REGISTRY_FILE} is not valid JSON; refusing to start and overwrite it: ${err.message}`
      );
    }
    throw err;
  }
}

/** write to a sibling temp file, fsync, rename, fsync the directory */
async function writeAtomic(data) {
  const dir = path.dirname(config.REGISTRY_FILE);
  const tmp = path.join(dir, `.projects.json.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify(data, null, 2) + '\n';

  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(body, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }

  try {
    await fsp.rename(tmp, config.REGISTRY_FILE);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }

  // Make the rename itself durable.
  let dh;
  try {
    dh = await fsp.open(dir, 'r');
    await dh.sync();
  } catch {
    /* not fatal; some filesystems disallow fsync on a directory handle */
  } finally {
    if (dh) await dh.close().catch(() => {});
  }
}

async function init() {
  await ensureDirs();
  cache = await loadFromDisk();
  return snapshot();
}

function requireInit() {
  if (cache === null) throw new Error('registry.init() has not been called');
}

function snapshot() {
  requireInit();
  return JSON.parse(JSON.stringify(cache));
}

function get(slug) {
  requireInit();
  return Object.prototype.hasOwnProperty.call(cache, slug)
    ? JSON.parse(JSON.stringify(cache[slug]))
    : null;
}

function has(slug) {
  requireInit();
  return Object.prototype.hasOwnProperty.call(cache, slug);
}

/**
 * Run `fn(draft)` under the registry lock. The draft is a deep copy; whatever
 * fn leaves in it is persisted atomically. If fn throws, nothing is written.
 * fn's return value is passed back to the caller.
 */
function transaction(fn) {
  const run = async () => {
    requireInit();
    const draft = JSON.parse(JSON.stringify(cache));
    const result = await fn(draft);
    await writeAtomic(draft);
    cache = draft;
    return result;
  };
  // Chain regardless of whether the previous transaction settled or rejected.
  const next = queue.then(run, run);
  queue = next.then(() => {}, () => {});
  return next;
}

/** Lowest free port in the pool, or null if the pool is exhausted. */
function allocatePort(draft) {
  const taken = new Set(Object.values(draft).map((p) => p.port));
  for (let i = 0; i < config.PORT_COUNT; i += 1) {
    const port = config.PORT_BASE + i;
    if (!taken.has(port)) return port;
  }
  return null;
}

module.exports = {
  init,
  snapshot,
  get,
  has,
  transaction,
  allocatePort,
  ensureDirs,
  // exported for tests
  _writeAtomic: writeAtomic,
};
