'use strict';

/**
 * Cloudflare Access JWT verification — defense in depth behind the tunnel.
 *
 * Spec §5 makes Cloudflare Access the only login. That is a property of the
 * Cloudflare account, not of this host: delete the Access application, typo its
 * domain, or add a broader one, and cloudflared will happily forward an
 * unauthenticated request to a shell. Access attaches a signed JWT to every
 * request it lets through (`Cf-Access-Jwt-Assertion`), so verifying it here
 * turns any of those mistakes into a 403 instead of an open terminal.
 *
 * Off unless both WEBTERM_ACCESS_TEAM and WEBTERM_ACCESS_AUD are set. When on,
 * there is no exemption — not for loopback (cloudflared itself connects from
 * loopback, so exempting it would exempt everything) and not for /api/health.
 *
 * Only RS256 is accepted; keys come from https://<team>/cdn-cgi/access/certs and
 * are refreshed when an unknown `kid` appears (rotation), at most once per
 * REFRESH_MIN_MS so a stream of garbage tokens cannot turn into a stream of
 * outbound fetches.
 */

const crypto = require('crypto');

const config = require('./config');

const HEADER = 'cf-access-jwt-assertion';
const CLOCK_SKEW_S = 60;
const REFRESH_MIN_MS = 30_000;
const MAX_TOKEN_LEN = 16 * 1024;

const enabled = () => Boolean(config.ACCESS_TEAM_DOMAIN && config.ACCESS_AUD.length);

/** Exactly one of the two set is a misconfiguration worth refusing to start over. */
const halfConfigured = () => Boolean(config.ACCESS_TEAM_DOMAIN) !== Boolean(config.ACCESS_AUD.length);

const certsUrl = () => `https://${config.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const issuer = () => `https://${config.ACCESS_TEAM_DOMAIN}`;

// ── key cache ───────────────────────────────────────────────────────────
let keys = new Map(); // kid -> KeyObject
let lastFetch = 0;
let inflight = null;

/** Injectable for tests: () => Promise<{keys: JWK[]}> */
let fetchJwks = async () => {
  const res = await fetch(certsUrl(), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`GET ${certsUrl()} -> ${res.status}`);
  return res.json();
};

async function refreshKeys({ force = false } = {}) {
  if (inflight) return inflight;
  if (!force && Date.now() - lastFetch < REFRESH_MIN_MS) return keys;
  lastFetch = Date.now();
  inflight = (async () => {
    try {
      const body = await fetchJwks();
      const next = new Map();
      for (const jwk of (body && body.keys) || []) {
        if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
        try {
          next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          /* skip a malformed key, keep the rest */
        }
      }
      if (next.size === 0) throw new Error('no usable RSA keys in the Access certs response');
      keys = next;
      return keys;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * @returns {Promise<{ok: true, claims: object} | {ok: false, reason: string}>}
 */
async function verify(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'no Access token' };
  if (token.length > MAX_TOKEN_LEN) return { ok: false, reason: 'token too large' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

  let header;
  let claims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return { ok: false, reason: 'malformed token' };
  }
  // Pin the algorithm: never let the token choose (alg=none, HS256-with-the-
  // public-key, and friends).
  if (!header || header.alg !== 'RS256') return { ok: false, reason: 'unexpected alg' };
  if (typeof header.kid !== 'string') return { ok: false, reason: 'no kid' };

  let key = keys.get(header.kid);
  if (!key) {
    try {
      await refreshKeys();
    } catch (err) {
      return { ok: false, reason: `could not load Access keys: ${err.message}` };
    }
    key = keys.get(header.kid);
    if (!key) return { ok: false, reason: 'unknown kid' };
  }

  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  let good = false;
  try {
    good = crypto.verify('RSA-SHA256', signed, key, sig);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'bad signature' };

  const nowS = Math.floor(now / 1000);
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'no claims' };
  if (claims.iss !== issuer()) return { ok: false, reason: 'wrong issuer' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => config.ACCESS_AUD.includes(a))) return { ok: false, reason: 'wrong audience' };
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S <= nowS) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > nowS) {
    return { ok: false, reason: 'not yet valid' };
  }
  return { ok: true, claims };
}

const tokenOf = (req) => {
  const v = req.headers && req.headers[HEADER];
  return Array.isArray(v) ? v[0] : v;
};

/** Express middleware. Mount first — before the dev gate, the proxy and static. */
async function middleware(req, res, next) {
  if (!enabled()) return next();
  const r = await verify(tokenOf(req));
  if (r.ok) return next();
  console.warn(`[access] refused ${req.method} ${req.originalUrl}: ${r.reason}`);
  res.status(403).json({ error: 'Cloudflare Access token missing or invalid' });
}

/** The WebSocket leg — Express never sees upgrades. */
async function authorizeUpgrade(req, socket) {
  if (!enabled()) return true;
  const r = await verify(tokenOf(req));
  if (r.ok) return true;
  console.warn(`[access] refused upgrade ${req.url}: ${r.reason}`);
  if (socket.writable) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
  socket.destroy();
  return false;
}

/** Tests only. */
function _setFetcher(fn) {
  fetchJwks = fn;
  keys = new Map();
  lastFetch = 0;
  inflight = null;
}

module.exports = {
  HEADER,
  enabled,
  halfConfigured,
  certsUrl,
  refreshKeys,
  verify,
  middleware,
  authorizeUpgrade,
  _setFetcher,
};
