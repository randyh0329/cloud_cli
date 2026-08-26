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
| 3. Reverse proxy `/term/<slug>/*` | not started |
| 4. Multi-tab xterm.js frontend | not started |
| 5. Paste-to-screenshot | not started |

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
npm test                       # ~29 tests, needs tmux
```

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
| `WEBTERM_STUB_SUPERVISOR` | unset | `1` skips all tmux/systemd side effects (frontend dev, tests) |

State layout:

```
~/webterm/
  projects.json            the registry — atomic rename on every change
  env/<slug>.env           WEBTERM_PORT / WEBTERM_CWD, read by ttyd@<slug>.service
  screenshots/<slug>/      pasted images; never auto-deleted, including on project delete
```

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Preflight: are tmux, ttyd and `systemd --user` usable? |
| `GET` | `/api/projects` | All projects with live unit + tmux status |
| `GET` | `/api/projects/:slug` | One project |
| `POST` | `/api/projects` | `{slug, cwd?}` → 201. Allocates a port, creates the tmux session, starts `ttyd@<slug>` |
| `DELETE` | `/api/projects/:slug` | Stops+disables the unit, kills the session, frees the port. Screenshots are kept |
| `POST` | `/api/upload` | *(milestone 5)* |

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

### Slugs

Validated as `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$` — stricter than the spec's `[a-z0-9-]`,
because a slug is interpolated into a filesystem path, a systemd unit name and a tmux target.
No leading or trailing hyphen (would be parsed as a flag), 32 characters max, and a short
reserved list (`api`, `term`, `default`, `system`, `user`, `.`, `..`). The registry re-validates
on load, so a hand-edited `projects.json` cannot smuggle a bad slug into a shell-out.

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

**Sessions died when I restarted webterm.** The transient scope wasn't available at the time —
webterm logs a warning when it falls back. Confirm lingering is on and `systemd-run` is present.

## Out of scope (v1)

Multi-user support, screenshot retention/cleanup, auto-starting Claude Code inside new sessions,
mobile paste UX, and dynamic Cloudflare ingress management.
