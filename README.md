# webterm — multi-project web terminal for Claude Code

A single-user, self-hosted web terminal reached through a Cloudflare Tunnel. Each project gets
its own `tmux` session fronted by its own `ttyd`, and the browser switches between them as tabs.
Paste a screenshot and its path is typed into the focused terminal.

Implements [`spec.md`](./spec.md).

```
Browser ──wss/https──► Cloudflare Tunnel ──► Cloudflare Access ──► 127.0.0.1:3000 (webterm)
                                                                     ├─ /            static UI
                                                                     ├─ /api/*       REST
                                                                     └─ /term/<slug> ─► 127.0.0.1:<port>
                                                                                         ttyd@<slug>.service
                                                                                         └─ tmux session <slug>
```

**Auth is Cloudflare Access and nothing else.** There is no in-app login. `ttyd` runs with
`--no-auth`, and both `ttyd` and webterm bind to `127.0.0.1`, so cloudflared is the only thing
that can reach them. Lock the Access policy to your own identity *before* the tunnel is live.

## Status

| Milestone | State |
|---|---|
| 1. Project registry + REST API | done |
| 2. tmux + `systemd --user` integration | done |
| 3. Reverse proxy `/term/<slug>/*` | done |
| 4. Multi-tab xterm.js frontend | done |
| 5. Paste-to-screenshot | done |

## Prerequisites

- Linux with systemd, Node.js ≥ 20
- `tmux`
- `ttyd` ≥ 1.7 (needs `-b/--base-path`)
- `cloudflared` already running with a tunnel pointing a hostname at this host

### Installing ttyd

Debian/Ubuntu ship `ttyd` in `apt`, but often at 1.6.x, which has no `-b` flag. Check first:

```bash
apt-cache policy ttyd          # if the candidate is >= 1.7.x:
sudo apt install -y ttyd
```

Otherwise take the static binary from the release page:

```bash
curl -fsSL -o /tmp/ttyd https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64
sudo install -m 0755 /tmp/ttyd /usr/local/bin/ttyd
ttyd --version                 # must be >= 1.7.0
```

### Enabling `systemd --user`

webterm manages `ttyd` through user units so it never needs root. On a headless VM the user
manager only exists while you are logged in, unless lingering is turned on — without this,
every `systemctl --user` call from webterm fails and project creation returns 503:

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" --property=Linger    # expect Linger=yes
ls -d /run/user/$(id -u)                        # must now exist
```

## Install

```bash
git clone https://github.com/randyh0329/cloud_cli.git ~/Lab/cc_cloud
cd ~/Lab/cc_cloud
npm install
npm test                       # 79 tests; needs tmux + python3, does not need ttyd
```

`npm test` includes a browser test that drives the real UI in headless Chrome. It looks for
`/usr/bin/google-chrome` (override with `CHROME_PATH`) and **skips itself** if Chrome is absent —
it never fails for that reason.

### Install the systemd units

`ttyd@.service` is copied into `~/.config/systemd/user/` automatically the first time you create
a project, and an existing copy is never overwritten (so local edits stick). To install or
re-sync it by hand:

```bash
npm run install-units          # force-copies systemd/ttyd@.service, then prints a preflight report
```

To run webterm itself as a user service, edit `WorkingDirectory` in `systemd/webterm.service` if
you cloned elsewhere, then:

```bash
install -Dm644 systemd/webterm.service ~/.config/systemd/user/webterm.service
systemctl --user daemon-reload
systemctl --user enable --now webterm.service
systemctl --user status webterm.service
journalctl --user -u webterm -f
```

### First run (foreground)

```bash
npm start
```

Boot output tells you what is and isn't ready:

```
webterm listening on http://127.0.0.1:3000
  state dir:       /home/you/webterm
  projects loaded: 0
  tmux:            /usr/bin/tmux tmux 3.5a
  ttyd:            /usr/local/bin/ttyd
  systemd --user:  running (linger: true)
```

Any `ERROR` line here means `POST /api/projects` will return **503** with the same message.
`GET /api/health` reports the same thing as JSON at any time.

### Point cloudflared at it

webterm listens on `127.0.0.1:3000`. **Do not add per-project hostnames** — the whole design
routes every project through this one origin, so the tunnel config is written once and never
changes when you add or remove a project.

In `~/.cloudflared/config.yml` (or the equivalent dashboard config):

```yaml
tunnel: <your-tunnel-uuid>
credentials-file: /home/you/.cloudflared/<uuid>.json

ingress:
  - hostname: term.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

```bash
sudo systemctl restart cloudflared
```

No `originRequest` tweaks are needed for WebSockets — cloudflared proxies the upgrade by default.
If you put a long-idle terminal behind it, consider raising Cloudflare's idle timeout.

Then, in Cloudflare Zero Trust → Access → Applications, add a self-hosted app for
`term.example.com` with a policy allowing exactly your email. Verify you get the Access login
screen from a logged-out browser before you rely on it.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | webterm's own port (always bound to `127.0.0.1`) |
| `WEBTERM_HOME` | `~/webterm` | State directory: registry, screenshots, unit env files |
| `WEBTERM_PORT_BASE` | `7681` | First port in the ttyd pool |
| `WEBTERM_PORT_COUNT` | `100` | Pool size, i.e. maximum concurrent projects |
| `WEBTERM_MAX_UPLOAD_BYTES` | `12582912` | Largest pasted image accepted (12 MB) |
| `WEBTERM_STUB_SUPERVISOR` | unset | `1` skips all tmux/systemd side effects (frontend dev, tests) |

State layout:

```
~/webterm/
  projects.json            the registry — atomic rename on every change
  env/<slug>.env           WEBTERM_PORT / WEBTERM_CWD, read by ttyd@<slug>.service
  screenshots/<slug>/      pasted images; never auto-deleted, including on project delete
```

### Running the whole thing without ttyd

`scripts/fake-ttyd.js` stands in for `ttyd -p <port> -i 127.0.0.1 -b /term/<slug> -W`: same base
path, same `/token` endpoint, same `tty`-subprotocol WebSocket, same wire protocol — and a real
pty behind it, via `scripts/ptyhost.py` (python3 stdlib, so `npm install` needs no build tools).
The frontend cannot tell it apart from the real thing.

```bash
WEBTERM_STUB_SUPERVISOR=1 npm start &
PORT=$(curl -s -XPOST localhost:3000/api/projects -H 'content-type: application/json' \
       -d '{"slug":"testproj"}' | jq -r .port)
node scripts/fake-ttyd.js testproj "$PORT" &          # default: tmux new -A -s testproj
```

Then open `http://localhost:3000/` and click the `testproj` tab — you get a working shell.
Pass a command after the port to run something other than tmux, e.g.
`node scripts/fake-ttyd.js testproj 7681 bash --norc -i`.

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Preflight: are tmux, ttyd and `systemd --user` usable? |
| `GET` | `/api/projects` | All projects with live unit + tmux status |
| `GET` | `/api/projects/:slug` | One project |
| `POST` | `/api/projects` | `{slug, cwd?}` → 201. Allocates a port, creates the tmux session, starts `ttyd@<slug>` |
| `DELETE` | `/api/projects/:slug` | Stops+disables the unit, kills the session, frees the port. Screenshots are kept |
| `POST` | `/api/upload` | `multipart/form-data {project, file}` → saves the image and types its path into the tmux pane |

```bash
curl -s localhost:3000/api/health | jq
curl -s -XPOST localhost:3000/api/projects \
     -H 'content-type: application/json' \
     -d '{"slug":"my-app","cwd":"/home/you/code/my-app"}' | jq
curl -s localhost:3000/api/projects | jq
curl -s -XDELETE localhost:3000/api/projects/my-app | jq
```

`cwd` is an addition to the spec: without it every project's shell would start in `$HOME`. It
must be an absolute path to an existing directory and defaults to `$HOME`.

## The `/term/<slug>/` proxy

Requests are forwarded to `127.0.0.1:<port>` with the path **unchanged**, because ttyd runs with
`-b /term/<slug>` and already expects that prefix. Stripping it would make ttyd emit `/`-rooted
asset, `/token` and `/ws` URLs that 404 on the way back.

- The slug segment is matched **raw**, before any percent-decoding, and validated against the
  same rule as the API. `%2e%2e`, `%2f`, `%00` and friends therefore never decode into a slug —
  they simply fail the character class and 404 without an upstream call being made.
- The proxy is mounted **before** `express.json()`. A body parser in front of it would consume
  the request stream and forward an empty body.
- WebSocket upgrades are handled on the `http.Server` directly, since Express never sees them.
- A registered project whose ttyd is down returns **502** with the `systemctl` command to run,
  on both the HTTP and the upgrade path — never a hang.

Everything after the slug is passed through verbatim, including `..` segments. That is correct
proxy behaviour and safe here because ttyd serves only its own embedded assets (webterm never
passes `-s`), but it is worth remembering if you ever add a static root to the ttyd command.

### Slugs

Validated as `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$` — stricter than the spec's `[a-z0-9-]`,
because a slug is interpolated into a filesystem path, a systemd unit name and a tmux target.
No leading or trailing hyphen (would be parsed as a flag), 32 characters max, and a short
reserved list (`api`, `term`, `default`, `system`, `user`, `.`, `..`). The registry re-validates
on load, so a hand-edited `projects.json` cannot smuggle a bad slug into a shell-out.

## The frontend

Plain `<script>` tags, no bundler, no framework. xterm.js is vendored as a prebuilt UMD bundle in
`public/vendor/`; `npm run vendor` re-copies it from `node_modules` after a version bump.

```
public/index.html      markup
public/app.css         all styling
public/js/ttyd-client.js   ttyd's WebSocket protocol, driving one xterm instance
public/js/app.js           tab manager, project CRUD, paste handler, toasts
public/vendor/         @xterm/xterm 6.0.0 + @xterm/addon-fit 0.11.0 (UMD) + LICENSE
```

**We talk to ttyd's protocol directly rather than iframing its page.** ttyd's own UI is one
terminal per page; tabs need N terminals in one document sharing one page's focus and paste
handling. So `ttyd-client.js` reimplements the client half of the protocol: `GET <base>/token`,
then a `tty`-subprotocol WebSocket whose first frame is `{AuthToken, columns, rows}`, then
single-byte-tagged binary frames (`0` input/output, `1` resize/title, `2` pause/preferences,
`3` resume). Flow control is honoured — the client sends PAUSE when its write queue passes 100 kB
and RESUME when it drains, so a `yes`-flood throttles the pty instead of the browser.

**Tab switching hides panes, it never destroys them** (spec §3.4). An inactive pane is
`display: none`; its xterm instance, scrollback and WebSocket all stay live, so switching back is
instant and nothing is missed while you were away. Terminals are created *lazily* on a tab's
first activation, because a hidden element has no dimensions and `FitAddon` would size it wrong;
after that they persist for the life of the page. The last active tab is remembered in
`localStorage`.

**Disconnects are visible and self-healing.** Each tab has a status dot (grey unopened, amber
connecting, green live, red down) and a disconnected pane shows an overlay with the reason, the
`systemctl --user status ttyd@<slug>.service` command to run, and a *Reconnect now* button.
Reconnects back off exponentially to 15 s.

**No global keyboard shortcuts.** Tab switching is click-only on purpose: every `Alt`, `Ctrl` and
function-key combination belongs to the program inside the terminal, and Claude Code uses a lot
of them.

Delete is right-click (or a 600 ms long-press on touch) on a tab, then a confirmation, then
`DELETE /api/projects/:slug`.

### Testing it

`test/frontend.test.js` runs the actual page in headless Chrome against `scripts/fake-ttyd.js`
and a real pty — no mocked DOM, no mocked socket. It asserts, among other things, that a hidden
tab's WebSocket is still `readyState === 1`, that its scrollback survives a round trip, that the
two tabs' shells are independent, and that `stty size` inside the pty agrees with the column
count `FitAddon` chose.

## Paste-to-screenshot

Copy an image anywhere, focus a terminal tab, press ⌘V / Ctrl+V. The image is saved under
`~/webterm/screenshots/<slug>/` and its absolute path is **typed** at the cursor — with a trailing
space and no Enter — so you can write the rest of the prompt around it before submitting.

```
paste ──► POST /api/upload (multipart: project, file)
             ├─ save  ~/webterm/screenshots/<slug>/2026-08-26T13-41-05-123Z.png
             └─ tmux send-keys -t '=<slug>:' -l -- '<that path> '
          ◄── 200 {path, filename, bytes, injected}   →  toast: "pasted → /path/…png"
```

The injection goes through tmux rather than the terminal's WebSocket (spec §3.5): it reaches the
session no matter which client is attached, and webterm never has to track individual sockets.

- The handler is on `document` in the **capture phase**, so it works whichever tab is focused and
  the image bytes never reach xterm. An ordinary **text** paste is not touched — xterm handles it.
- The upload is tagged with the **currently active tab's** slug.
- **The file type comes from the bytes, not from the client.** The first few bytes must match PNG,
  JPEG, GIF or WebP; the declared `Content-Type` and the multipart `filename` are both ignored, so
  a `filename` of `../../../../etc/cron.d/pwned.png` changes nothing about where the file lands.
- The name is always a server-generated timestamp (`2026-08-26T13-41-05-123Z.png`), opened `wx` at
  mode 0600, so two pastes in the same millisecond cannot overwrite each other.
- Uploads are buffered in memory, never staged in a temp file, so a rejected paste leaves nothing
  on disk. Anything over `WEBTERM_MAX_UPLOAD_BYTES` is a 413.
- If the tmux session has died, the response is still **200** with `injected: false` and a
  `warning` — the file was saved, and the UI shows a red toast with the path so the paste is not
  silently lost.

## Deviations from spec.md

Each of these was flagged before implementation:

1. **`-b /term/<slug>` added to the ttyd command.** Spec §3.1's command serves everything at `/`,
   so behind the `/term/<slug>/` proxy mount ttyd would emit `/`-rooted URLs that 404.
2. **`-i 127.0.0.1` added.** Spec §5 requires a loopback bind; ttyd's default is all interfaces.
3. **`send-keys` gets `-l --`.** Spec §3.5's `tmux send-keys -t <slug> "<path> "` resolves each
   argument as a *key name* first, so a payload like `Enter` would be executed instead of typed.
4. **Exact tmux targets.** `-t <slug>` prefix-matches, so it can hit `<slug>-two`. Sessions use
   `=<slug>`; panes use `=<slug>:` (verified against tmux 3.5a — `=<slug>` fails for panes).
5. **Absolute paths in the registry.** Spec §3.3's example stores a literal `~/…`, which nothing
   expands.
6. **Screenshot filenames avoid `:`.** ISO 8601's colons are legal but awkward everywhere else.
7. **Optional `cwd` field** on projects — see above.
8. **The tmux server is started inside a transient systemd scope.** A tmux server inherits the
   cgroup of whatever spawned it. Left alone it would land inside `webterm.service` (so restarting
   webterm would kill every project's shell) or inside `ttyd@<slug>.service` (so deleting one
   project would kill all the others). `systemd-run --user --scope` decouples it. webterm also
   always creates the session before starting ttyd, so ttyd's `tmux new -A` never spawns a server.
9. **Terminals connect lazily.** Spec §3.4 requires that a tab switch never reconnects, which this
   honours — but it does not require opening N WebSockets to N ptys the moment the page loads. A
   tab's terminal is created on its first activation and lives forever after. tmux keeps the
   session running in the meantime either way, so nothing is lost by waiting.
10. **The injected path is shell-quoted only if it needs it.** Spec §3.5 types the bare path, which
    is right — Claude Code's path detection wants it bare, and paths under `~/webterm/screenshots/`
    contain nothing a shell reacts to. But `$HOME` is not ours to assume: if it holds a space or a
    quote, an unquoted path silently becomes two arguments. So a path outside
    `[A-Za-z0-9_@%+=:,./-]` gets single-quoted, and every ordinary path stays bare.
11. **A dead tmux session is a 200, not an error.** Spec §3.5 responds `200 {path}`. When the file
    saved but `send-keys` failed there is no honest 2xx-or-4xx answer, and returning an error would
    imply the upload was lost. The response carries `injected: false` and a `warning` instead, and
    the toast turns red.

## Troubleshooting

**`POST /api/projects` returns 503** — read `GET /api/health`; the `problems` array names the
exact fix. Usually missing `ttyd` or missing lingering.

**Unit won't start.** The 500 response body includes a `journal` field with the tail of the unit
log. Directly:

```bash
systemctl --user status ttyd@my-app.service
journalctl --user -u ttyd@my-app.service -n 50 --no-pager
cat ~/webterm/env/my-app.env
```

**`ttyd: invalid option -- 'b'`** — ttyd is older than 1.7. Reinstall from the release binary.

**A terminal is blank but the unit is active.** The tmux session and the ttyd process are
independent; check `tmux ls`. `GET /api/projects` reports both (`status.unit`, `status.tmux`).

**Pasting a screenshot does nothing.** The browser only puts an image on the clipboard for a real
image copy — "copy image" in a page, a screenshot tool, ⌘⇧4 on macOS. Copying a *file* in a file
manager yields a file reference, not `image/*`, and falls through to a normal text paste. If a red
toast appears instead, it carries the reason. Over the tunnel this needs HTTPS, which Cloudflare
already provides; on a plain-HTTP origin some browsers withhold clipboard image data.

**Sessions died when I restarted webterm.** The transient scope wasn't available at the time —
webterm logs a warning when it falls back. Confirm lingering is on and `systemd-run` is present.

## Out of scope (v1)

Multi-user support, screenshot retention/cleanup, auto-starting Claude Code inside new sessions,
mobile paste UX, and dynamic Cloudflare ingress management.
