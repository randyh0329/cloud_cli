#!/usr/bin/env bash
#
# End-to-end smoke test against the real thing: real ttyd, real tmux, real
# `systemd --user`, real headless browser.
#
#   ./scripts/smoke.sh
#
# `npm test` covers everything that can be faked. This covers what cannot:
# whether ttyd accepts our flags, whether ttyd@.service actually starts, whether
# the tmux server survives a webterm restart, and whether the browser can drive
# a shell through the proxy. Run it on the box that will host webterm.
#
# It uses your real state directory (~/webterm) because ttyd@.service hardcodes
# EnvironmentFile=%h/webterm/env/%i.env — a temp WEBTERM_HOME would be invisible
# to systemd. It creates one project with a random slug and removes it (and its
# unit, session and env file) on exit, including on Ctrl-C.
#
# Environment:
#   SMOKE_PORT   port for the webterm under test (default 3999)
#   SMOKE_KEEP=1 leave the project in place at the end, for poking at by hand
#   CHROME_PATH  browser for the UI step; it self-skips if none is found

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-3999}"
BASE="http://127.0.0.1:$PORT"
SLUG="smoke-$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
STATE="$HOME/webterm"
TMP="$(mktemp -d)"
LOG="$TMP/webterm.log"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else B=; G=; Y=; R=; D=; N=; fi

PASS=0
FAIL=0
step()  { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()    { printf '  %s✓%s %s\n' "$G" "$N" "$*"; PASS=$((PASS + 1)); }
bad()   { printf '  %s✗%s %s\n' "$R" "$N" "$*"; FAIL=$((FAIL + 1)); }
warn()  { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
note()  { printf '    %s%s%s\n' "$D" "$*" "$N"; }
die()   { printf '\n%sfatal:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# expect <description> <actual> <expected>
expect() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1"; note "expected: $3"; note "     got: $2"; fi
}
# expect_match <description> <actual> <extended regex>
expect_match() {
  if printf '%s' "$2" | grep -Eq -- "$3"; then ok "$1"; else bad "$1"; note "  /$3/ did not match:"; note "$(printf '%s' "$2" | head -c 400)"; fi
}

WEBTERM_PID=""
PROJECT_CREATED=0

CLEANED=0
cleanup() {
  local rc=$?
  [ "$CLEANED" = "1" ] && exit "$rc"
  CLEANED=1
  if [ "${SMOKE_KEEP:-0}" = "1" ] && [ "$PROJECT_CREATED" = "1" ]; then
    printf '\n%sSMOKE_KEEP=1: leaving project %s in place%s\n' "$Y" "$SLUG" "$N"
    printf '  webterm is still running on %s (pid %s); kill it when done.\n' "$BASE" "$WEBTERM_PID"
    exit "$rc"
  fi
  [ -n "$WEBTERM_PID" ] && kill "$WEBTERM_PID" 2>/dev/null
  # Tear the project down directly rather than through the API: the API may be
  # the thing that just failed.
  systemctl --user disable --now "ttyd@$SLUG.service" >/dev/null 2>&1
  systemctl --user reset-failed "ttyd@$SLUG.service" >/dev/null 2>&1
  tmux kill-session -t "=$SLUG" >/dev/null 2>&1
  rm -f "$STATE/env/$SLUG.env"
  if [ "$PROJECT_CREATED" = "1" ]; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1], slug = process.argv[2];
      try {
        const d = JSON.parse(fs.readFileSync(p, "utf8"));
        if (Object.prototype.hasOwnProperty.call(d, slug)) {
          delete d[slug];
          fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
        }
      } catch (e) { /* nothing to clean */ }
    ' "$STATE/projects.json" "$SLUG" 2>/dev/null
  fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------- helpers ----
# api <METHOD> <path> [json]  ->  sets API_CODE and API_BODY
API_CODE=""
API_BODY=""
api() {
  local out
  # --path-as-is: the proxy tests deliberately send paths curl would otherwise
  # normalise away before they ever reach us.
  if [ $# -ge 3 ]; then
    out="$(curl -sS --path-as-is -X "$1" "$BASE$2" -H 'content-type: application/json' -d "$3" -w $'\n%{http_code}' 2>&1)"
  else
    out="$(curl -sS --path-as-is -X "$1" "$BASE$2" -w $'\n%{http_code}' 2>&1)"
  fi
  API_CODE="${out##*$'\n'}"
  API_BODY="${out%$'\n'*}"
}

# Everything listening on <port>, as "addr:port" lines.
listeners() { ss -ltnH "sport = :$1" 2>/dev/null | awk '{print $4}'; }

# expect_loopback_only <description> <port> — nothing routable may be bound.
expect_loopback_only() {
  local addrs
  addrs="$(listeners "$2")"
  if [ -z "$addrs" ]; then
    bad "$1"; note "nothing is listening on port $2"
  elif printf '%s\n' "$addrs" | grep -Ev '^(127\.0\.0\.1|\[::1\]):' | grep -q .; then
    bad "$1"; note "bound to: $(printf '%s' "$addrs" | tr '\n' ' ')"
  else
    ok "$1 ($(printf '%s' "$addrs" | tr '\n' ' '))"
  fi
}

wait_for_listener() {
  local port="$1" tries="${2:-40}"
  for _ in $(seq "$tries"); do
    [ -n "$(listeners "$port")" ] && return 0
    sleep 0.25
  done
  return 1
}

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

# ============================================================== preflight ====
step "Preflight"
cd "$REPO" || die "cannot cd to $REPO"
for bin in node npm tmux ttyd curl jq ss systemctl loginctl; do
  command -v "$bin" >/dev/null || die "$bin is not installed — run ./install.sh first"
done
ok "node $(node -v), $(tmux -V), ttyd $(ttyd --version 2>&1 | grep -oE '[0-9.]+' | head -1)"

[ -d node_modules/ws ] || die "node_modules/ws is missing — run npm install"

if systemctl --user is-active --quiet webterm.service 2>/dev/null; then
  die "webterm.service is already running. Two webterms would both write $STATE/projects.json.
  Stop it first:  systemctl --user stop webterm.service"
fi
ok "no other webterm is running as a user unit"

if [ -n "$(listeners "$PORT")" ]; then
  die "something is already listening on port $PORT — set SMOKE_PORT to another port"
fi

loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q 'Linger=yes' \
  || warn "lingering is off; user units will die when you log out (sudo loginctl enable-linger $USER)"
[ -d "/run/user/$(id -u)" ] || die "/run/user/$(id -u) does not exist — the systemd user manager is not running"
ok "systemd --user is reachable"

# ======================================================== ttyd bind probe ====
# The one thing we could never check without a real ttyd: whether -i takes a
# dotted quad. ttyd documents an interface *name*; some builds accept both.
# Whichever works becomes WEBTERM_TTYD_IFACE for the rest of this run.
step "ttyd bind probe (-i)"
ttyd --help 2>&1 | grep -q -- '--base-path' \
  || die "this ttyd has no --base-path; it is older than 1.7 and cannot sit behind the proxy"
ok "ttyd supports --base-path"

IFACE=""
for candidate in 127.0.0.1 lo; do
  pport="$(free_port)"
  ttyd -p "$pport" -i "$candidate" -b /probe -W sleep 30 >"$TMP/probe-$candidate.log" 2>&1 &
  ppid=$!
  if wait_for_listener "$pport" 24; then
    addrs="$(listeners "$pport")"
    kill "$ppid" 2>/dev/null; wait "$ppid" 2>/dev/null
    if printf '%s' "$addrs" | grep -Eq '^(127\.0\.0\.1|\[::1\]):'; then
      IFACE="$candidate"
      ok "ttyd -i $candidate binds $addrs (loopback only)"
      break
    fi
    # Not fatal: we fall back to the next spelling. But it is exactly the
    # failure spec §5 cares about, so say it loudly.
    warn "ttyd -i $candidate bound $addrs — that is NOT loopback-only; trying the next form"
  else
    kill "$ppid" 2>/dev/null; wait "$ppid" 2>/dev/null
    warn "ttyd -i $candidate did not listen: $(head -3 "$TMP/probe-$candidate.log" | tr '\n' ' ')"
  fi
done
[ -n "$IFACE" ] || die "ttyd would not bind loopback with -i 127.0.0.1 or -i lo. See $TMP/probe-*.log"
[ "$IFACE" = "127.0.0.1" ] || warn "using WEBTERM_TTYD_IFACE=$IFACE — put this in webterm's environment permanently"
export WEBTERM_TTYD_IFACE="$IFACE"

# ============================================================ unit + boot ====
step "Install the unit and start webterm on $BASE"
npm run --silent install-units >"$TMP/install-units.log" 2>&1
grep -q 'ttyd@.service' "$TMP/install-units.log" && ok "ttyd@.service synced to ~/.config/systemd/user/" \
  || bad "install-units did not report installing the template ($TMP/install-units.log)"

PORT="$PORT" node server/index.js >"$LOG" 2>&1 &
WEBTERM_PID=$!
for _ in $(seq 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  kill -0 "$WEBTERM_PID" 2>/dev/null || { cat "$LOG"; die "webterm exited during startup"; }
  sleep 0.25
done
curl -sf "$BASE/api/health" >/dev/null 2>&1 || { cat "$LOG"; die "webterm never answered on $BASE"; }
ok "webterm is up (pid $WEBTERM_PID)"

expect_loopback_only "webterm listens on loopback only" "$PORT"

api GET /api/health
expect "GET /api/health -> 200" "$API_CODE" "200"
HEALTH_OK="$(printf '%s' "$API_BODY" | jq -r '.ok')"
if [ "$HEALTH_OK" = "true" ]; then
  ok "health reports the host is ready"
else
  bad "health reports problems:"
  printf '%s' "$API_BODY" | jq -r '.supervisor.problems[] | "      \(.fatal|if . then "ERROR" else "warn " end)  \(.message)"'
fi

# ============================================================ create ========
step "Create project $SLUG"
api POST /api/projects "{\"slug\":\"$SLUG\"}"
if [ "$API_CODE" != "201" ]; then
  bad "POST /api/projects -> $API_CODE"
  note "$(printf '%s' "$API_BODY" | head -c 800)"
  note "webterm log tail:"
  tail -20 "$LOG" | sed 's/^/      /'
  die "cannot continue without a project"
fi
PROJECT_CREATED=1
TTYD_PORT="$(printf '%s' "$API_BODY" | jq -r '.port')"
ok "POST /api/projects -> 201, ttyd port $TTYD_PORT"

expect "the unit is active" "$(systemctl --user is-active "ttyd@$SLUG.service")" "active"
if tmux has-session -t "=$SLUG" 2>/dev/null; then ok "tmux session \"$SLUG\" exists"; else bad "tmux session \"$SLUG\" is missing"; fi

ENVFILE="$STATE/env/$SLUG.env"
if [ -f "$ENVFILE" ]; then
  expect "the env file is 0600" "$(stat -c '%a' "$ENVFILE")" "600"
  expect_match "the env file carries the bind interface" "$(cat "$ENVFILE")" "WEBTERM_IFACE=\"$IFACE\""
else
  bad "$ENVFILE was not written"
fi

expect_loopback_only "ttyd is bound to loopback only" "$TTYD_PORT"

# The tmux server must NOT be inside the ttyd unit's cgroup, or deleting one
# project would kill every other project's shell.
TMUX_CG="$(tr -d '\0' < "/proc/$(tmux display-message -p -t "=$SLUG:" '#{pid}' 2>/dev/null)/cgroup" 2>/dev/null | tail -1)"
if [ -n "$TMUX_CG" ]; then
  if printf '%s' "$TMUX_CG" | grep -q "ttyd@$SLUG"; then
    bad "the tmux server is inside ttyd@$SLUG.service's cgroup — deleting this project would kill all sessions"
    note "$TMUX_CG"
  else
    ok "the tmux server lives outside the ttyd unit's cgroup"
    note "$TMUX_CG"
  fi
else
  warn "could not read the tmux server's cgroup"
fi

# ============================================================== proxy =======
step "Proxy /term/$SLUG/"
api GET "/term/$SLUG/"
expect "GET /term/$SLUG/ -> 200" "$API_CODE" "200"
expect_match "ttyd's own page is served through the proxy" "$API_BODY" '<title>|<script'

api GET "/term/$SLUG/token"
expect "GET /term/$SLUG/token -> 200" "$API_CODE" "200"
expect_match "the token response is JSON" "$API_BODY" '"token"'

api GET "/term/nosuchproject/token"
expect "an unregistered slug is a 404, with no upstream call" "$API_CODE" "404"
api GET "/term/..%2f..%2fetc/token"
expect "a percent-encoded traversal in the slug is a 404" "$API_CODE" "404"
api GET "/term/Bad_Slug/token"
expect "an invalid slug is a 404" "$API_CODE" "404"

# ============================================================ websocket =====
step "ttyd WebSocket protocol"
if node scripts/smoke-ws.js --base "$BASE" --slug "$SLUG"; then
  ok "token, upgrade, auth frame, I/O and resize all agree with real ttyd"
else
  bad "scripts/smoke-ws.js failed (see its output above)"
fi

# ============================================================== upload ======
step "Paste-to-screenshot"
printf '\x89PNG\r\n\x1a\nIHDR smoke test payload' > "$TMP/shot.png"
UPLOAD="$(curl -sS -X POST "$BASE/api/upload" -F "project=$SLUG" -F "file=@$TMP/shot.png;type=image/png")"
SHOT_PATH="$(printf '%s' "$UPLOAD" | jq -r '.path // empty')"
expect "the upload reports it was injected" "$(printf '%s' "$UPLOAD" | jq -r '.injected')" "true"
if [ -n "$SHOT_PATH" ] && [ -f "$SHOT_PATH" ]; then
  ok "saved to $SHOT_PATH"
  expect "the screenshot is 0600" "$(stat -c '%a' "$SHOT_PATH")" "600"
  expect_match "the filename is a server-generated timestamp" "$(basename "$SHOT_PATH")" '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z\.png$'
else
  bad "no file at the reported path: ${SHOT_PATH:-<none>}"
  note "$(printf '%s' "$UPLOAD" | head -c 400)"
fi

sleep 0.5
# -J joins wrapped lines, so a path that spans two rows is still one string.
PANE="$(tmux capture-pane -pJ -t "=$SLUG:" 2>/dev/null | tr -d '\n')"
if [ -n "$SHOT_PATH" ] && printf '%s' "$PANE" | grep -qF "$(basename "$SHOT_PATH")"; then
  ok "tmux typed the path onto the command line"
else
  bad "the path is not on the pane's command line"
  note "$(printf '%s' "$PANE" | tail -c 300)"
fi
if printf '%s' "$PANE" | grep -Eqi 'command not found|cannot execute|Permission denied'; then
  bad "the shell tried to RUN the path — an Enter was sent with it"
  note "$(printf '%s' "$PANE" | tail -c 300)"
else
  ok "the path was typed but not executed"
fi
tmux send-keys -t "=$SLUG:" C-u 2>/dev/null

# a non-image must be refused
NOTIMG="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/upload" \
          -F "project=$SLUG" -F "file=@$REPO/package.json;filename=evil.png;type=image/png")"
expect "a non-image is rejected with 400 even when it claims image/png" "$NOTIMG" "400"

# ==================================================== restart resilience ====
step "Restarts do not kill the shell"
tmux send-keys -t "=$SLUG:" -l -- 'MARKER=alive-before-restart' 2>/dev/null
tmux send-keys -t "=$SLUG:" Enter 2>/dev/null
sleep 0.3

systemctl --user restart "ttyd@$SLUG.service"
sleep 1.5
expect "the unit came back" "$(systemctl --user is-active "ttyd@$SLUG.service")" "active"
if tmux has-session -t "=$SLUG" 2>/dev/null; then ok "restarting ttyd left the tmux session alone"; else bad "restarting ttyd killed the tmux session"; fi
api GET "/term/$SLUG/token"
expect "the proxy works again after a ttyd restart" "$API_CODE" "200"

kill "$WEBTERM_PID" 2>/dev/null
wait "$WEBTERM_PID" 2>/dev/null
sleep 0.5
if tmux has-session -t "=$SLUG" 2>/dev/null; then
  ok "stopping webterm left the tmux session alone"
else
  bad "stopping webterm killed the tmux session — the transient scope is not working"
fi

PORT="$PORT" node server/index.js >>"$LOG" 2>&1 &
WEBTERM_PID=$!
for _ in $(seq 60); do curl -sf "$BASE/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
if curl -sf "$BASE/api/health" >/dev/null 2>&1; then
  ok "webterm restarted (pid $WEBTERM_PID)"
else
  tail -20 "$LOG" | sed 's/^/      /'
  die "webterm did not come back up on $BASE"
fi

api GET "/api/projects/$SLUG"
expect "the project survived the restart" "$(printf '%s' "$API_BODY" | jq -r '.slug')" "$SLUG"
expect "and its shell is still there" "$(printf '%s' "$API_BODY" | jq -r '.status.tmux')" "true"

# Confirm the shell really is the same one, not a fresh session.
tmux send-keys -t "=$SLUG:" -l -- 'echo "restart-check:$MARKER"' 2>/dev/null
tmux send-keys -t "=$SLUG:" Enter 2>/dev/null
sleep 0.5
expect_match "the shell kept its state across both restarts" \
  "$(tmux capture-pane -p -t "=$SLUG:" 2>/dev/null)" 'restart-check:alive-before-restart'

# ============================================================== browser =====
step "Headless browser against real ttyd"
if node scripts/smoke-browser.js --base "$BASE" --slug "$SLUG" --shot /tmp/webterm-smoke.png; then
  ok "the UI drove a real shell, and a pasted screenshot came back through tmux"
else
  bad "scripts/smoke-browser.js failed (see its output above)"
fi

# ============================================================== delete ======
step "Delete $SLUG"
api DELETE "/api/projects/$SLUG"
expect "DELETE /api/projects/$SLUG -> 200" "$API_CODE" "200"
KEPT="$(printf '%s' "$API_BODY" | jq -r '.screenshots_kept_at // empty')"
PROJECT_CREATED=0

sleep 0.5
expect "the unit is gone" "$(systemctl --user is-active "ttyd@$SLUG.service")" "inactive"
if tmux has-session -t "=$SLUG" 2>/dev/null; then bad "the tmux session outlived the delete"; else ok "the tmux session is gone"; fi
if [ -f "$ENVFILE" ]; then bad "$ENVFILE was left behind"; else ok "the env file was removed"; fi
if [ -n "$(listeners "$TTYD_PORT")" ]; then bad "port $TTYD_PORT is still bound"; else ok "port $TTYD_PORT was released"; fi
if [ -n "$KEPT" ] && [ -d "$KEPT" ]; then
  ok "screenshots kept at $KEPT (spec §4 — never auto-deleted)"
  # Only ours, and only under the screenshots root.
  case "$KEPT" in "$STATE/screenshots/$SLUG") rm -rf "$KEPT" ;; *) warn "not removing $KEPT — unexpected location" ;; esac
else
  bad "the screenshot directory was removed, or not reported"
fi

# =============================================================== summary ====
step "Summary"
printf '  %s%d passed%s, %s%d failed%s\n' "$G" "$PASS" "$N" "$([ "$FAIL" -gt 0 ] && printf '%s' "$R" || printf '%s' "$D")" "$FAIL" "$N"
if [ "$FAIL" -gt 0 ]; then
  printf '\n  webterm log: %s\n' "$LOG"
  cp "$LOG" /tmp/webterm-smoke.log 2>/dev/null && printf '  copied to /tmp/webterm-smoke.log\n'
  printf '  journal:     journalctl --user -u "ttyd@%s.service" -n 50 --no-pager\n' "$SLUG"
  exit 1
fi
printf '  %sttyd bind interface that works here: -i %s%s\n' "$D" "$IFACE" "$N"
exit 0
