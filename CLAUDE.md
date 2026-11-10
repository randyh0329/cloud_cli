# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`webterm` — a single-user, self-hosted multi-project web terminal. One Node process on
`127.0.0.1:3000` fronts N per-project `ttyd` instances (one `systemd --user` template unit each),
which in turn front N `tmux` sessions. The browser is a tab manager over those sessions.
Auth is Cloudflare Access in front of a tunnel; there is no in-app login (except the dev-mode gate,
below). webterm can verify the Access JWT itself (`server/access.js`, opt-in via
`WEBTERM_ACCESS_TEAM`/`_AUD`).

`spec.md` is the original contract. `README.md` is the user-facing manual and carries a
**"Deviations from spec.md"** section — when you deliberately depart from the spec, add a numbered
entry there with the reason. That list is the project's record of why the code differs.

No bundler, no framework, no transpiler, no linter config. CommonJS, `'use strict'`, Node ≥ 20.
Dependencies are deliberately few (`express`, `http-proxy`, `multer`); keep it that way.

## Commands

```bash
npm test                          # all unit + integration + browser tests (node:test)
node --test test/proxy.test.js    # one file
node --test --test-name-pattern 'slug' test/proxy.test.js   # one test
npm start                         # foreground on 127.0.0.1:3000; boot output is a preflight report
npm run install-units             # sync systemd units into ~/.config/systemd/user/
npm run enable-boot               # same, plus enable webterm.service at boot
npm run vendor                    # re-copy xterm.js/addon-fit UMD builds into public/vendor/
./scripts/smoke.sh                # ~60s end-to-end against real ttyd + systemd + tmux
./scripts/dev-mode.sh on|off|status   # password gate + non-loopback bind, for browser testing
./install.sh                      # fresh-Ubuntu bootstrap (tmux, Node, ttyd, Chrome, linger)
```

Running the whole stack without `ttyd` installed (frontend work):

```bash
WEBTERM_STUB_SUPERVISOR=1 npm start &
curl -s -XPOST localhost:3000/api/projects -H 'content-type: application/json' -d '{"slug":"testproj"}'
node scripts/fake-ttyd.js testproj <port>    # speaks ttyd's wire protocol over a real pty
```

## Architecture

### Request pipeline (`server/app.js`) — order is load-bearing

`access.middleware` → `auth.middleware` → `guard.middleware` → `proxy.httpMiddleware` →
`express.json()` → `/api` router → static `public/`.

- The three gates are first because `/term/<slug>/` *is* a shell; a gate mounted after the proxy is
  decorative. `access` verifies the Cloudflare Access JWT, `auth` is the dev-mode password, and
  `guard` sets security headers and refuses cross-origin unsafe methods.
- The proxy is before `express.json()` because a body parser would consume the request stream and
  forward an empty body to ttyd.
- WebSocket upgrades never reach Express. They are wired onto the `http.Server` in
  `server/index.js` (`access.authorizeUpgrade` → `auth.authorizeUpgrade` →
  `guard.authorizeUpgrade` → `proxy.handleUpgrade`). Any change to auth, origin checks or proxying
  must be made in **both** the Express path and the upgrade path.

### Module layering (`server/`)

```
index.js       process entry: bind interlock, preflight, upgrade wiring, --install-units
app.js         Express wiring only
routes.js      /api/* handlers + multer config
projects.js    project CRUD policy (cwd resolution, create/delete orchestration)
registry.js    ~/webterm/projects.json — in-memory cache, serialized RMW, atomic rename
supervisor.js  the only module with tmux+systemd side effects; real/stub swap
  tmux.js      tmux argv
  systemd.js   unit rendering, install, systemctl --user
proxy.js       /term/<slug>/* → 127.0.0.1:<port>, HTTP + ws
screenshots.js upload validation, naming, injection
access.js      Cloudflare Access JWT verification (RS256, JWKS cache), no-op unless configured
auth.js        dev-mode password gate (HMAC cookie), no-op unless WEBTERM_DEV_PASSWORD is set
guard.js       same-origin check (unsafe methods + upgrades) and security headers / CSP
slug.js exec.js errors.js config.js
```

`exec.js` is the only place that spawns processes; it always uses an argv array, never a shell.

### Invariants that are easy to break

- **`config.js` reads `process.env` at require time.** Tests must set `WEBTERM_HOME`,
  `WEBTERM_STUB_SUPERVISOR`, etc. *before* the first `require('../server/...')`. Every test file
  does this at the top; follow the pattern.
- **`supervisor.js` exports a real or stub object chosen at module load** (`module.exports =
  config.STUB_SUPERVISOR ? stub : real`). Flipping the env var later does nothing. Both objects
  must keep the same shape — adding a method to `real` without adding it to `stub` breaks every
  stubbed test.
- **Every supervisor method is idempotent.** `up()` on a live project succeeds; `down()` on a gone
  one succeeds.
- **The tmux session is always created before ttyd starts,** inside a `systemd-run --user --scope`
  transient scope. A tmux server inherits its spawner's cgroup: inside `webterm.service`,
  restarting Node kills every shell; inside `ttyd@<slug>.service`, deleting one project kills all
  the others.
- **tmux targets are exact.** Sessions use `=<slug>`, panes use `=<slug>:` (a bare `=<slug>` errors
  for panes). A plain `-t <slug>` prefix-matches and will hit `<slug>-two`.
- **`send-keys` uses `-l --`.** Without `-l` each argument is resolved as a key name first, so a
  payload like `Enter` would execute instead of being typed.
- **The proxy matches the slug segment raw, before percent-decoding,** against the same character
  class as the API. That is what makes `%2e%2e` / `%2f` / `%00` fail closed instead of decoding
  into a slug. Do not add a `decodeURIComponent` in front of it. The path is otherwise forwarded
  **unchanged** — ttyd runs with `-b /term/<slug>` and expects the prefix.
- **Registry writes go through the single promise queue in `registry.js`** so concurrent POSTs
  can't allocate the same port. `sanitiseLoaded` re-validates slugs on load, so a hand-edited
  `projects.json` can't smuggle a bad slug into a unit name or shell-out.
- **Upload type comes from the magic bytes,** never from `Content-Type` or the multipart
  `filename`; the saved name is a server-generated timestamp opened `wx` at 0600. Uploads are
  buffered in memory so a rejected paste leaves nothing on disk.
- **ttyd runs with `-O`, and the proxy keeps the browser's `Host` (`changeOrigin: false`).** The
  two depend on each other: rewriting `Host` makes every same-origin WebSocket fail ttyd's origin
  check. Don't drop either.
- **Access verification has no exemptions** (no loopback bypass: cloudflared connects from
  loopback) **and fails closed** when keys can't be fetched. Only RS256 is accepted; never let the
  token's `alg` choose.
- **The UI CSP is `script-src 'self'`.** Keep `public/index.html` free of inline scripts and
  `on*=` handlers. `style-src` allows inline only because xterm.js injects `<style>`.
- **Binding non-loopback without a dev password is a fatal startup error** (`assertBindIsSafe` in
  `index.js`). Keep it fatal.
- **`systemd/webterm.service` in git carries a `/path/to/cloud_cli` placeholder** and is rewritten
  with the real checkout path on install (`systemd.renderMainUnit`). Don't "fix" the placeholder.

### Frontend (`public/`)

Plain `<script>` tags; xterm.js is vendored as a prebuilt UMD bundle in `public/vendor/`.

- `ttyd-client.js` reimplements the *client half of ttyd's protocol* (`GET <base>/token`, then a
  `tty`-subprotocol WebSocket, then single-byte-tagged binary frames) rather than iframing ttyd's
  page — tabs need N terminals in one document sharing focus and paste handling. Flow control
  (PAUSE/RESUME above/below a 100 kB queue) is implemented and should stay.
- Tab switching **hides** panes (`display: none`); it never tears down an xterm instance or its
  socket. Terminals are created lazily on first activation, because `FitAddon` mis-sizes a hidden
  element.
- **No global keyboard shortcuts** — every modifier combination belongs to the program inside the
  terminal (Claude Code uses many). Tab switching is click-only, on purpose.
- Paste is a **capture-phase** listener on `document`; image bytes never reach xterm, plain text
  paste falls through to xterm untouched. The path is injected via `tmux send-keys`, not the
  WebSocket, so it lands regardless of which client is attached.

## Tests

`node:test`, no runner or assertion library beyond the stdlib. What each file needs:

| File | Needs |
|---|---|
| `api` `proxy` `upload` `auth` `access` `guard` `registry` `systemd` | nothing (supervisor stubbed / pure; `access` signs its own JWTs with a generated key) |
| `inject` `tmux` | real `tmux` (deliberately **not** stubbed; sets `TMUX_TMPDIR` to isolate) |
| `frontend` | headless Chrome at `CHROME_PATH` or `/usr/bin/google-chrome` — **skips**, never fails, if absent; also needs `python3` for `scripts/ptyhost.py` |

Conventions: each file makes its own `mkdtemp` `WEBTERM_HOME` (and `WEBTERM_PROJECTS_ROOT` where a
blank `cwd` is exercised) before requiring server modules, and isolates tmux with `TMUX_TMPDIR`.
`frontend.test.js` drives the real page in a real browser against `scripts/fake-ttyd.js` and a real
pty — no mocked DOM, no mocked socket.

`npm test` never touches real ttyd or systemd. That coverage lives in `scripts/smoke.sh`, which
runs against the actual host, uses the real `~/webterm`, and refuses to start if `webterm.service`
is already active.
