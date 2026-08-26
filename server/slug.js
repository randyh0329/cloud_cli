'use strict';

const { badRequest } = require('./errors');

// A slug ends up in three hostile places:
//   - filesystem paths      (~/webterm/screenshots/<slug>)
//   - a systemd unit name   (ttyd@<slug>.service)
//   - a tmux target         (tmux send-keys -t <slug>)
// so it is deliberately narrower than any of those need.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MAX_LEN = 32;

// systemd escapes '-' in instance names to path separators for %f/%I expansion,
// and treats a few names specially. We never rely on %f, but reserve the
// obviously dangerous ones anyway.
const RESERVED = new Set(['.', '..', 'default', 'system', 'user', 'new', 'api', 'term']);

/**
 * Validate an untrusted slug. Returns the slug unchanged, or throws HttpError(400).
 * Callers must use the *returned* value, never the original input.
 */
function assertSlug(value) {
  if (typeof value !== 'string') {
    throw badRequest('slug is required and must be a string');
  }
  const slug = value.trim();
  if (slug.length === 0) throw badRequest('slug must not be empty');
  if (slug.length > MAX_LEN) throw badRequest(`slug must be at most ${MAX_LEN} characters`);
  if (!SLUG_RE.test(slug)) {
    throw badRequest(
      'slug must match [a-z0-9-], start and end with a letter or digit'
    );
  }
  if (RESERVED.has(slug)) throw badRequest(`slug "${slug}" is reserved`);
  return slug;
}

function isValidSlug(value) {
  try {
    assertSlug(value);
    return true;
  } catch {
    return false;
  }
}

module.exports = { assertSlug, isValidSlug, SLUG_RE, MAX_LEN };
