#!/usr/bin/env bash
# token-tracker installer (Linux + macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/A-Gift-Of-Flame/token-tracker/main/install.sh | bash
#   # or, from a clone:  ./install.sh
#
# Does everything end to end so there are no follow-up commands:
#   1. checks Node >= 22.5
#   2. puts the `tt` binary on your PATH
#   3. signs you in to your server (GitHub device flow) with auto-push on
#   4. installs the always-on boot service (systemd / launchd) so usage syncs
#      forever, across reboots and crashes
#
# Re-running is safe: each step is skipped if already done.
#
# Config (optional): set TT_ENDPOINT to skip the prompt, e.g.
#   TT_ENDPOINT=https://tt.example.com ./install.sh

set -euo pipefail

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Node ---------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node >= 22.5 from https://nodejs.org and re-run."
NODE_MAJOR=$(node -p 'process.versions.node.split(".").map(Number)[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".").map(Number)[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  die "Node >= 22.5 required (found $(node -v)). Upgrade and re-run."
fi
say "Node $(node -v) OK"

# --- locate source ---------------------------------------------------------
# When piped from curl there is no clone; fetch one. When run from a clone, use it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/bin/tt.js" ]; then
  SRC="$SCRIPT_DIR"
else
  SRC="${TT_HOME:-$HOME/.local/share/token-tracker/repo}"
  say "Fetching token-tracker into $SRC"
  command -v git >/dev/null 2>&1 || die "git not found and not running from a clone. Install git or clone the repo."
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" pull --ff-only --quiet
  else
    mkdir -p "$(dirname "$SRC")"
    git clone --depth 1 https://github.com/A-Gift-Of-Flame/token-tracker.git "$SRC" --quiet
  fi
fi

# --- 2. PATH ---------------------------------------------------------------
# Prefer a stable symlink in ~/.local/bin so we never depend on npm global state.
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "$SRC/bin/tt.js" "$BIN_DIR/tt"
chmod +x "$SRC/bin/tt.js"
TT="$BIN_DIR/tt"
say "Installed: $TT"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add to your shell rc:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# --- 3. sign in (only if not already configured) ---------------------------
REMOTE_JSON="${TOKEN_TRACKER_DIR:-$HOME/.token-tracker}/remote.json"
if [ -f "$REMOTE_JSON" ]; then
  say "Already signed in ($REMOTE_JSON) — leaving auth as is."
else
  ENDPOINT="${TT_ENDPOINT:-}"
  if [ -z "$ENDPOINT" ]; then
    if [ -t 0 ]; then
      printf 'Server URL (e.g. https://tt.example.com): '
      read -r ENDPOINT
    else
      warn "No TT_ENDPOINT set and not interactive — skipping sign-in."
      warn "Later run:  tt login --github --endpoint https://YOUR_SERVER --auto-push"
    fi
  fi
  if [ -n "$ENDPOINT" ]; then
    say "Signing in to $ENDPOINT (GitHub device flow, auto-push on)"
    "$TT" login --github --endpoint "$ENDPOINT" --auto-push
  fi
fi

# --- 4. boot service -------------------------------------------------------
INSTALL_PRESENCE=0
if [ "${TT_PRESENCE:-}" = "1" ]; then
  INSTALL_PRESENCE=1
elif [ -t 0 ]; then
  printf 'Install always-on Discord presence too? [y/N]: '
  read -r PRESENCE_REPLY
  case "$PRESENCE_REPLY" in
    y|Y|yes|YES|Yes) INSTALL_PRESENCE=1 ;;
  esac
fi

say "Installing always-on sync service"
if [ "$INSTALL_PRESENCE" = "1" ]; then
  "$TT" service install --presence
else
  "$TT" service install
fi

say "Done. Usage now syncs automatically, forever. Nothing else to run."
