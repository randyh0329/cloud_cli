# Web Terminal for Claude Code — Multi-Project + Screenshot Paste

## 1. Goal

A self-hosted web terminal, reached via Cloudflare Tunnel, that lets Randy:
- Switch between multiple project terminals via browser tabs (each backed by its own `tmux` session running Claude Code)
- Add/remove projects at runtime from the UI, with no redeploy and no Cloudflare tunnel config changes
- Paste a screenshot directly into the browser and have its file path automatically typed into the currently focused terminal

Single user. Auth is handled entirely by Cloudflare Access in front of the tunnel — no in-app login system.

## 2. Architecture

```
Browser
  │  wss/https  →  single hostname (e.g. term.example.com)
  ▼
Cloudflare Tunnel  →  Cloudflare Access (auth gate)
  ▼
Node.js App Server (single process, localhost only)
  ├─ Static frontend (vanilla JS + xterm.js, multi-tab)
  ├─ REST API (/api/*)          — project CRUD, image upload
  └─ WS/HTTP reverse proxy      — /term/<slug>/*  →  127.0.0.1:<port> (ttyd)
        │
        ▼
  ttyd@<slug>.service (systemd template unit, one per project)
  binds 127.0.0.1:<port>, --no-auth (perimeter auth only)
  command: tmux new -A -s <slug>
        │
        ▼
  tmux session <slug>  →  Claude Code running inside
```

Key decision: **cloudflared only ever points at one hostname → the Node app.** New projects never touch tunnel config; the Node app does the path-based fan-out to per-project ttyd ports internally. This was chosen over per-project hostnames specifically to avoid Cloudflare API/ingress churn on every add/remove.

## 3. Components

### 3.1 ttyd (per project)
- One `ttyd` process per project, managed as a systemd **template unit**: `ttyd@.service`, instantiated as `ttyd@project-a.service`
- Bound to `127.0.0.1:<port>` only — never exposed directly, reachable solely through the Node proxy
- No built-in Basic Auth (`-c`) — perimeter auth is Cloudflare Access; defense-in-depth is the localhost bind
- Launch command: `ttyd -p <port> -W tmux new -A -s <slug>` (`-W` allows client-initiated resize; `-A` on tmux attaches if the session already exists, survives ttyd/Node restarts)

### 3.2 tmux (per project)
- Session name == project slug
- Never killed by ttyd restarts or Node restarts — only killed on explicit project deletion
- Claude Code is expected to be started inside manually (out of scope for this spec — first tmux window just drops to shell)

### 3.3 Node.js App Server
Single process, responsibilities:
- Serves static frontend
- REST API for project management and image upload
- Reverse-proxies `/term/<slug>/` (including WebSocket upgrade) to the matching ttyd's localhost port
- Owns the **project registry** (JSON file, e.g. `~/webterm/projects.json`), atomic write on change:
  ```json
  {
    "project-a": { "port": 7681, "created_at": "...", "screenshot_dir": "~/webterm/screenshots/project-a" },
    "project-b": { "port": 7682, "created_at": "...", "screenshot_dir": "~/webterm/screenshots/project-b" }
  }
  ```
- Port allocation: pool starting at a base (e.g. 7681), next free port on create, released on delete
- Runs systemd/tmux commands as the same OS user (no sudo needed if the unit files are user-level `systemd --user` template units — **prefer `systemd --user` over system-level units** to avoid granting the Node process any sudo/systemctl-as-root capability)

### 3.4 Frontend (vanilla JS + xterm.js)
- One `<div>` + one `xterm.js` instance per open project tab; hidden via CSS when not active, WebSocket connection stays alive in the background (no reconnect churn on tab switch)
- Tab bar: existing tabs rebuilt on load from `GET /api/projects`; "+ New Project" button prompts for a slug, calls `POST /api/projects`, opens a new tab once the service reports ready
- Delete: right-click / long-press a tab → confirm → `DELETE /api/projects/:slug`, tab removed
- Paste handler: attached at the document level (not per-terminal), so it works regardless of which tab is focused. On `paste` event, if `clipboardData.items` contains `image/*`:
  - Prevent default (don't let raw bytes fall through to the terminal)
  - Read blob, `POST /api/upload` as `multipart/form-data` with the **currently active tab's slug**
  - No further frontend action needed — the server injects the path server-side (see 3.5)

### 3.5 Image Upload + Injection Flow
`POST /api/upload` (fields: `project` slug, `file` image):
1. Validate slug exists in registry
2. Save to `<screenshot_dir>/<ISO-timestamp>.png`
3. Inject path into the terminal via `tmux send-keys -t <slug> "<absolute path> "` — **no trailing Enter**, so the path lands at the cursor and Randy can type the rest of the prompt around it before submitting
4. Respond `200 {path}` to frontend (used only for a toast/confirmation, e.g. "pasted → /path/to/x.png")

This deliberately goes through `tmux send-keys` rather than the ttyd WebSocket — it's simpler (backend already shells out to tmux for session management), works no matter which client is attached, and avoids needing to track individual xterm/WS instances server-side.

### 3.6 Routing scheme
- `term.example.com/` → frontend static files
- `term.example.com/api/*` → Node REST API
- `term.example.com/term/<slug>/*` (incl. WS upgrade) → proxied to `127.0.0.1:<port>` for that slug

## 4. API Summary

| Method | Path | Purpose |
|---|---|---|
| GET | /api/projects | List all projects + status (ttyd unit active?) |
| POST | /api/projects | `{slug}` → allocate port, create tmux session, install+start `ttyd@<slug>`, persist registry |
| DELETE | /api/projects/:slug | Stop+disable unit, kill tmux session, remove registry entry (screenshots left on disk, not auto-deleted) |
| POST | /api/upload | `multipart/form-data {project, file}` → save + `tmux send-keys` inject |

## 5. Security Notes
- Cloudflare Access is the only auth layer — confirm the Access policy is locked to Randy's identity/email before exposing anything
- ttyd and the Node app both bind to `127.0.0.1` only; nothing but cloudflared should be able to reach these ports
- Slug validation: restrict to `[a-z0-9-]`, used directly in filesystem paths and systemd unit names — must be sanitized to prevent path traversal / unit injection
- Prefer `systemd --user` units so the Node process never needs root/sudo to manage ttyd lifecycles
- Screenshot files may contain sensitive info — no external exposure beyond the existing Access-gated tunnel; consider a retention/cleanup cron later (out of scope for v1)

## 6. Out of Scope (v1)
- Multi-user support / per-user project isolation
- Automatic screenshot cleanup/retention policy
- Auto-starting Claude Code inside new tmux sessions
- Mobile-specific paste UX (relies on existing Telegram bot for phone-based screenshot sharing)
- Dynamic Cloudflare hostname/ingress management (explicitly rejected in favor of path-based single-hostname routing)

