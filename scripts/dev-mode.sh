#!/usr/bin/env bash
#
# Temporarily expose webterm on a public address behind a password, for testing
# from a real browser before the Cloudflare tunnel exists.
#
#   ./scripts/dev-mode.sh on            # prompts for the password
#   ./scripts/dev-mode.sh status
#   ./scripts/dev-mode.sh off           # back to loopback-only, no gate
#
# This is a deliberate, temporary downgrade of spec §5. What you are turning on:
#
#   * webterm binds 0.0.0.0 instead of 127.0.0.1 — every route to an
#     interactive shell becomes reachable from the network
#   * the only thing in front of that shell is one shared password
#   * there is no TLS, so the password and the entire terminal session,
#     keystrokes included, cross the network in clear text
#
# So: firewall the port to your own address, and run `off` when you are done.
# ttyd itself is untouched and stays on 127.0.0.1 — only the Node proxy moves.
#
# Flags for `on`:
#   --password PW   non-interactive (also read from $WEBTERM_DEV_PASSWORD)
#   --bind ADDR     default 0.0.0.0
#   --port N        default 3000
#   --no-restart    write the config but leave the running service alone

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=webterm.service
UNIT_DIR="$HOME/.config/systemd/user"
DROPIN_DIR="$UNIT_DIR/$UNIT.d"
DROPIN="$DROPIN_DIR/dev-mode.conf"
ENV_FILE="$HOME/webterm/dev-mode.env"
MIN_PASSWORD=8

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else B=; G=; Y=; R=; D=; N=; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
note() { printf '  %s%s%s\n' "$D" "$*" "$N"; }
die()  { printf '\n%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
sc() { systemctl --user "$@"; }

# ------------------------------------------------------------------ args ----
ACTION="${1:-}"; shift || true
BIND=0.0.0.0
PORT=3000
PASSWORD="${WEBTERM_DEV_PASSWORD:-}"
RESTART=1
while [ $# -gt 0 ]; do
  case "$1" in
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --bind)     BIND="${2:-}";     shift 2 ;;
    --port)     PORT="${2:-}";     shift 2 ;;
    --no-restart) RESTART=0; shift ;;
    -h|--help)  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

listeners() { ss -ltnH "sport = :$1" 2>/dev/null | awk '{print $4}' | sort -u | tr '\n' ' '; }

show_status() {
  step "Status"
  local state enabled
  state="$(sc is-active "$UNIT" 2>&1 || true)"
  enabled="$(sc is-enabled "$UNIT" 2>&1 || true)"
  note "$UNIT: $state, $enabled at boot"
  if [ -f "$DROPIN" ]; then
    warn "dev mode is ON — $DROPIN"
    note "$(grep -c . "$ENV_FILE" 2>/dev/null || echo 0) settings in $ENV_FILE (password not shown)"
  else
    ok "dev mode is off (loopback only, no password gate)"
  fi
  local addrs; addrs="$(listeners "$PORT")"
  note "listening on :$PORT -> ${addrs:-nothing}"
  case "$addrs" in
    "") ;;
    *0.0.0.0*|*'*:'*|*'[::]'*) warn "reachable from the network" ;;
    *) ok "loopback only" ;;
  esac
}

# -------------------------------------------------------------------- on ----
turn_on() {
  [ -d "$UNIT_DIR" ] || die "$UNIT_DIR does not exist — run: npm run enable-boot"
  [ -f "$UNIT_DIR/$UNIT" ] || die "$UNIT is not installed — run: npm run enable-boot"

  if [ -z "$PASSWORD" ]; then
    printf 'Password for the webterm dev gate (input hidden): '
    read -rs PASSWORD; printf '\n'
    printf 'Again: '
    read -rs CONFIRM; printf '\n'
    [ "$PASSWORD" = "$CONFIRM" ] || die "the two passwords do not match"
  fi
  [ "${#PASSWORD}" -ge "$MIN_PASSWORD" ] \
    || die "use at least $MIN_PASSWORD characters — this password is the only thing in front of a shell"
  # systemd's EnvironmentFile takes single-quoted values literally, with no
  # escape for an embedded single quote. Rejecting one is better than shipping
  # a password the service silently reads back wrong.
  case "$PASSWORD" in
    *"'"*) die "the password cannot contain a single quote (systemd EnvironmentFile limitation)" ;;
  esac

  step "Write the dev-mode configuration"
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077
  cat >"$ENV_FILE" <<EOF
# Written by scripts/dev-mode.sh. Contains the webterm dev password in clear
# text; it is 0600 and must stay that way. Remove with: ./scripts/dev-mode.sh off
WEBTERM_BIND=$BIND
PORT=$PORT
WEBTERM_DEV_PASSWORD='$PASSWORD'
EOF
  chmod 600 "$ENV_FILE"
  ok "$ENV_FILE (0600)"

  mkdir -p "$DROPIN_DIR"
  cat >"$DROPIN" <<EOF
# Written by scripts/dev-mode.sh — TEMPORARY.
# Puts an interactive shell on $BIND:$PORT behind a single password, with no
# TLS. Delete this file (or run ./scripts/dev-mode.sh off) to go back to the
# loopback-only posture the spec asks for.
[Service]
EnvironmentFile=$ENV_FILE
EOF
  chmod 644 "$DROPIN"
  ok "$DROPIN"

  sc daemon-reload
  if [ "$RESTART" -eq 0 ]; then
    warn "--no-restart: the running service is still on its old settings"
    return
  fi

  step "Restart $UNIT"
  sc restart "$UNIT"
  for _ in $(seq 40); do
    curl -sf "http://127.0.0.1:$PORT/login" >/dev/null 2>&1 && break
    sleep 0.25
  done
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/login" \
    || die "webterm did not come up with a login page — journalctl --user -u $UNIT -n 30"
  ok "the login page is being served"

  # The gate is worth nothing if any route slips past it; check the two that
  # matter from outside the process.
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/projects")"
  [ "$code" = "401" ] && ok "/api/projects is gated (401)" || warn "/api/projects answered $code, expected 401"
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")"
  [ "$code" = "302" ] && ok "/ redirects to the login form" || warn "/ answered $code, expected 302"

  local addrs; addrs="$(listeners "$PORT")"
  ok "listening on ${addrs:-?}"

  local ip
  ip="$(curl -s -m 3 -H 'Metadata-Flavor: Google' \
        http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || true)"
  step "Dev mode is ON"
  cat <<EOF
  URL       http://${ip:-<this-host>}:$PORT/
  Password  (the one you just set)

  ${Y}!${N} No TLS: the password and every keystroke cross the network in clear text.
  ${Y}!${N} Anything that can reach $BIND:$PORT is one password away from your shell.
      Keep the firewall scoped to your own address, and when you are done:

        $REPO/scripts/dev-mode.sh off
EOF
}

# ------------------------------------------------------------------- off ----
turn_off() {
  step "Remove the dev-mode configuration"
  [ -f "$DROPIN" ] && { rm -f "$DROPIN"; ok "removed $DROPIN"; } || note "no drop-in to remove"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
  [ -f "$ENV_FILE" ] && { rm -f "$ENV_FILE"; ok "removed $ENV_FILE (password gone)"; } || note "no env file to remove"
  sc daemon-reload

  if [ "$RESTART" -eq 1 ] && [ "$(sc is-active "$UNIT" 2>&1 || true)" = "active" ]; then
    step "Restart $UNIT"
    sc restart "$UNIT"
    sleep 1.5
    local addrs; addrs="$(listeners "$PORT")"
    case "$addrs" in
      *0.0.0.0*|*'*:'*|*'[::]'*) die "still bound to $addrs — check for a stray drop-in in $DROPIN_DIR" ;;
      "") warn "nothing is listening on :$PORT" ;;
      *) ok "back to loopback only ($addrs)" ;;
    esac
  fi
  step "Dev mode is OFF"
  note "Remember to delete the firewall rule that opened :$PORT."
}

case "$ACTION" in
  on)     turn_on;  show_status ;;
  off)    turn_off; show_status ;;
  status) show_status ;;
  *) die "usage: $0 {on|off|status} [--password PW] [--bind ADDR] [--port N] [--no-restart]" ;;
esac
