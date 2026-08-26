#!/usr/bin/env bash
#
# Provision a fresh Ubuntu/Debian VM to run webterm and its full test suite.
#
#   git clone https://github.com/randyh0329/cloud_cli.git ~/webterm-src
#   cd ~/webterm-src && ./install.sh
#
# Installs: build essentials, tmux, Node LTS, ttyd >= 1.7, a headless browser,
# then enables lingering and runs `npm install`. Idempotent — re-running it
# skips whatever is already present and correct.
#
# Run as a normal user with sudo. NOT as root: everything webterm does runs in
# your own `systemd --user` manager, and root has no such manager on a VM.
#
# Flags:
#   --no-browser   skip Chrome/Chromium (the browser tests then self-skip)
#   --no-ttyd      skip ttyd (unit tests still pass; the smoke test will not)
#   -h|--help

set -euo pipefail

WITH_BROWSER=1
WITH_TTYD=1
for arg in "$@"; do
  case "$arg" in
    --no-browser) WITH_BROWSER=0 ;;
    --no-ttyd)    WITH_TTYD=0 ;;
    -h|--help)    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MIN_MAJOR=20
TTYD_MIN="1.7.0"

# ---------------------------------------------------------------- output ----
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else B=; G=; Y=; R=; N=; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# ------------------------------------------------------------ sanity ----
[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not root — webterm drives \`systemd --user\`, and root has no user manager on a headless VM."
command -v sudo >/dev/null || die "sudo is required"
command -v apt-get >/dev/null || die "this script targets Debian/Ubuntu (apt-get not found). See README for a manual install."

# Fail early rather than half-way through, if sudo will prompt on a pipe.
sudo -v || die "sudo authentication failed"

ARCH="$(dpkg --print-architecture)"    # amd64 | arm64 | ...
case "$ARCH" in
  amd64) NODE_ARCH=x64;   TTYD_ARCH=x86_64 ;;
  arm64) NODE_ARCH=arm64; TTYD_ARCH=aarch64 ;;
  armhf) NODE_ARCH=armv7l; TTYD_ARCH=armhf ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

. /etc/os-release 2>/dev/null || true
step "Host: ${PRETTY_NAME:-unknown} ($ARCH)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --------------------------------------------------------------- apt ----
step "Base packages"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
# xz-utils: unpacking the Node tarball.  iproute2: `ss`, used by the smoke test
# to prove ttyd is bound to loopback only.  python3: scripts/ptyhost.py.
sudo apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg jq git tmux python3 xz-utils iproute2 procps
ok "curl jq git tmux python3 xz-utils iproute2"

# -------------------------------------------------------------- node ----
step "Node.js >= $NODE_MIN_MAJOR"
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ]; then
  ok "already have $(node -v) at $(command -v node)"
else
  # The official tarball rather than NodeSource: no third-party apt repo, no
  # postinst scripts, and the version is pinned by the checksum we verify.
  VER="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0].version')"
  [ -n "$VER" ] && [ "$VER" != "null" ] || die "could not determine the current Node LTS version"
  TARBALL="node-${VER}-linux-${NODE_ARCH}.tar.xz"
  echo "  downloading $TARBALL"
  curl -fsSL -o "$TMP/$TARBALL"  "https://nodejs.org/dist/${VER}/${TARBALL}"
  curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/${VER}/SHASUMS256.txt"
  # This proves the download is intact, not that nodejs.org is trustworthy —
  # the checksum comes from the same origin over the same TLS connection.
  ( cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c - >/dev/null ) \
    || die "checksum mismatch on $TARBALL — refusing to install"
  sudo mkdir -p /usr/local/lib/nodejs
  sudo tar -xJf "$TMP/$TARBALL" -C /usr/local/lib/nodejs
  # Symlink rather than copy into /usr/local/bin, so a later version swap is one
  # `ln -sf` and `npm` keeps finding its own lib/ next to the binary.
  for bin in node npm npx; do
    sudo ln -sfn "/usr/local/lib/nodejs/node-${VER}-linux-${NODE_ARCH}/bin/$bin" "/usr/local/bin/$bin"
  done
  hash -r
  [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ] || die "node still reports $(node -v 2>&1)"
  ok "installed $(node -v)"
fi

# -------------------------------------------------------------- ttyd ----
# 1.7 introduced -b/--base-path, which the whole /term/<slug>/ proxy depends on.
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
ttyd_version() { ttyd --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

if [ "$WITH_TTYD" -eq 0 ]; then
  step "ttyd — skipped (--no-ttyd)"
else
  step "ttyd >= $TTYD_MIN"
  if command -v ttyd >/dev/null && ver_ge "$(ttyd_version)" "$TTYD_MIN"; then
    ok "already have ttyd $(ttyd_version) at $(command -v ttyd)"
  else
    # Ubuntu 24.04 ships 1.7.4; 22.04 ships 1.6.3, which has no -b.
    CAND="$(apt-cache policy ttyd 2>/dev/null | awk '/Candidate:/{print $2}' | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' || true)"
    if [ -n "$CAND" ] && ver_ge "$CAND" "$TTYD_MIN"; then
      sudo apt-get install -y -qq ttyd
      ok "installed ttyd $(ttyd_version) from apt (candidate was $CAND)"
    else
      [ -n "$CAND" ] && warn "apt only offers ttyd $CAND, which has no -b/--base-path"
      URL="https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH}"
      echo "  downloading $URL"
      curl -fsSL -o "$TMP/ttyd" "$URL" || die "could not download the ttyd release binary for $TTYD_ARCH"
      sudo install -m 0755 "$TMP/ttyd" /usr/local/bin/ttyd
      hash -r
      ver_ge "$(ttyd_version)" "$TTYD_MIN" || die "installed ttyd reports $(ttyd_version), need >= $TTYD_MIN"
      ok "installed ttyd $(ttyd_version) to /usr/local/bin"
    fi
  fi
  ttyd --help 2>&1 | grep -q -- '--base-path' || die "this ttyd has no --base-path; the /term/<slug>/ proxy cannot work"
  ok "--base-path is supported"
fi

# ----------------------------------------------------------- browser ----
if [ "$WITH_BROWSER" -eq 0 ]; then
  step "Headless browser — skipped (--no-browser)"
elif [ -x /usr/bin/google-chrome ] || [ -x /usr/bin/chromium ] || [ -x /usr/bin/chromium-browser ]; then
  step "Headless browser"
  ok "already present"
else
  step "Headless browser"
  # puppeteer-core drives a system browser; we never download one through npm.
  if [ "$ARCH" = "amd64" ]; then
    sudo install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | sudo gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
    sudo chmod 0644 /etc/apt/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      | sudo tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq google-chrome-stable
    ok "installed $(/usr/bin/google-chrome --version)"
  else
    # Google publishes no arm64 Chrome .deb. On Ubuntu, `chromium` is a snap
    # transitional package whose sandbox does not play well in a container, so
    # this may need CHROME_PATH pointed somewhere else.
    sudo apt-get install -y -qq chromium || sudo apt-get install -y -qq chromium-browser \
      || warn "no chromium package found — browser tests will skip themselves"
    for c in /usr/bin/chromium /usr/bin/chromium-browser; do
      if [ -x "$c" ]; then ok "installed $("$c" --version 2>&1 | head -1)"; break; fi
    done
  fi
fi

# Everything downstream looks for CHROME_PATH first, then /usr/bin/google-chrome.
BROWSER=""
for c in /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
  if [ -x "$c" ]; then BROWSER="$c"; break; fi
done

# ------------------------------------------------------------ linger ----
step "systemd --user lingering"
if loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q 'Linger=yes'; then
  ok "already enabled"
else
  sudo loginctl enable-linger "$USER"
  ok "enabled for $USER"
fi
for _ in $(seq 20); do [ -d "/run/user/$(id -u)" ] && break; sleep 0.25; done
[ -d "/run/user/$(id -u)" ] || die "/run/user/$(id -u) still does not exist — the user manager did not start"
XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user is-system-running >/dev/null 2>&1 \
  || warn "systemctl --user is reachable but the manager reports a degraded state (usually harmless)"
ok "/run/user/$(id -u) is present"

# -------------------------------------------------------------- deps ----
step "npm install"
cd "$REPO"
npm install --no-audit --no-fund
ok "$(ls node_modules | wc -l) packages in $REPO/node_modules"

step "systemd unit"
npm run --silent install-units || warn "install-units reported a problem — see its output above"

# ------------------------------------------------------------- done ----
step "Ready"
cat <<EOF
  node      $(node -v)
  tmux      $(tmux -V)
  ttyd      $(command -v ttyd >/dev/null && ttyd_version || echo 'not installed')
  browser   ${BROWSER:-none (browser tests will skip)}
  linger    $(loginctl show-user "$USER" --property=Linger | cut -d= -f2)

Next:
  cd $REPO
  npm test              # unit + browser suite, no ttyd or systemd needed
  ./scripts/smoke.sh    # end-to-end against real ttyd, systemd --user and tmux
EOF
if [ -n "$BROWSER" ] && [ "$BROWSER" != /usr/bin/google-chrome ]; then
  echo "  (export CHROME_PATH=$BROWSER first — the default path is /usr/bin/google-chrome)"
fi
exit 0
