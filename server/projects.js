'use strict';

const fsp = require('fs').promises;
const path = require('path');

const config = require('./config');
const registry = require('./registry');
const supervisor = require('./supervisor');
const { assertSlug } = require('./slug');
const { badRequest, notFound, conflict, HttpError } = require('./errors');

/** Validate an optional working directory; returns an absolute, existing dir. */
async function resolveCwd(value) {
  if (value === undefined || value === null || value === '') return config.DEFAULT_CWD;
  if (typeof value !== 'string') throw badRequest('cwd must be a string');
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) throw badRequest('cwd must be an absolute path');
  const resolved = path.resolve(trimmed);
  let st;
  try {
    st = await fsp.stat(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') throw badRequest(`cwd does not exist: ${resolved}`);
    throw badRequest(`cwd is not readable: ${resolved} (${err.code})`);
  }
  if (!st.isDirectory()) throw badRequest(`cwd is not a directory: ${resolved}`);
  return resolved;
}

function toPublic(slug, entry, status) {
  return {
    slug,
    port: entry.port,
    cwd: entry.cwd,
    created_at: entry.created_at,
    screenshot_dir: entry.screenshot_dir,
    url: `/term/${slug}/`,
    status: status || null,
  };
}

async function list() {
  const all = registry.snapshot();
  const slugs = Object.keys(all).sort(
    (a, b) => String(all[a].created_at).localeCompare(String(all[b].created_at)) || a.localeCompare(b)
  );
  // Two subprocess calls total, not two per project.
  const statuses = await supervisor
    .statusAll(slugs)
    .catch(() => new Map(slugs.map((s) => [s, { unit: 'unknown', tmux: null }])));
  return slugs.map((slug) => toPublic(slug, all[slug], statuses.get(slug) || null));
}

async function getOne(rawSlug) {
  const slug = assertSlug(rawSlug);
  const entry = registry.get(slug);
  if (!entry) throw notFound(`no such project: ${slug}`);
  const status = await supervisor.status(slug).catch(() => ({ unit: 'unknown', tmux: null }));
  return toPublic(slug, entry, status);
}

async function create(body) {
  if (!body || typeof body !== 'object') throw badRequest('expected a JSON object body');
  const slug = assertSlug(body.slug);
  const cwd = await resolveCwd(body.cwd);

  // Phase 1: reserve the slug + a port under the registry lock. Kept short so
  // we never hold the lock across a shell-out.
  const entry = await registry.transaction((draft) => {
    if (Object.prototype.hasOwnProperty.call(draft, slug)) {
      throw conflict(`project "${slug}" already exists`);
    }
    const port = registry.allocatePort(draft);
    if (port === null) {
      throw new HttpError(
        503,
        `port pool exhausted (${config.PORT_BASE}-${config.PORT_BASE + config.PORT_COUNT - 1})`
      );
    }
    const record = {
      port,
      cwd,
      created_at: new Date().toISOString(),
      screenshot_dir: path.join(config.SCREENSHOTS_DIR, slug),
    };
    draft[slug] = record;
    return record;
  });

  // Phase 2: side effects. On failure, release the reservation so a retry works.
  try {
    await fsp.mkdir(entry.screenshot_dir, { recursive: true, mode: 0o700 });
    await supervisor.up({ slug, port: entry.port, cwd: entry.cwd });
  } catch (err) {
    await supervisor.down({ slug, port: entry.port }).catch(() => {});
    await registry
      .transaction((draft) => {
        delete draft[slug];
      })
      .catch(() => {});
    throw err;
  }

  const status = await supervisor.status(slug).catch(() => ({ unit: 'unknown', tmux: null }));
  return toPublic(slug, entry, status);
}

async function remove(rawSlug) {
  const slug = assertSlug(rawSlug);
  const entry = registry.get(slug);
  if (!entry) throw notFound(`no such project: ${slug}`);

  // Tear down the system state first: if it fails we keep the registry entry so
  // the project stays visible and the delete is retryable, rather than leaking
  // an orphaned unit with no record of it.
  await supervisor.down({ slug, port: entry.port });

  await registry.transaction((draft) => {
    delete draft[slug];
  });

  // Screenshots are deliberately left on disk (spec §4).
  return { slug, removed: true, screenshots_kept_at: entry.screenshot_dir };
}

module.exports = { list, getOne, create, remove, resolveCwd };
