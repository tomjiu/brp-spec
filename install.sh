#!/usr/bin/env bash
# BRP Native Messaging Host Installer (Linux / macOS)
#
# Installs the native messaging manifest for Firefox and/or Zen,
# replacing the placeholder path with the real brp-bridge binary location.
#
# Usage:
#   ./install.sh                 # Install for detected browser(s)
#   ./install.sh --browser firefox  # Install for Firefox only
#   ./install.sh --browser zen      # Install for Zen only
#   ./install.sh --browser both     # Install for both
#   ./install.sh --uninstall        # Remove manifests for all browsers
#   ./install.sh --uninstall --browser firefox  # Remove Firefox only
#
# Requires: cargo build --release (bridge binary must exist)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_TEMPLATE="$PROJECT_DIR/native-manifest/org.brp.bridge.json"
BINARY="$PROJECT_DIR/bridge/target/release/brp-bridge"

# ─── Platform detection ───

case "$(uname -s)" in
  Linux)   OS="linux" ;;
  Darwin)  OS="macos" ;;
  *)
    echo "ERROR: Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

# Firefox / Zen native messaging directories
if [ "$OS" = "macos" ]; then
  FIREFOX_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  ZEN_DIR="$HOME/Library/Application Support/zen/NativeMessagingHosts"
else
  FIREFOX_DIR="$HOME/.mozilla/native-messaging-hosts"
  ZEN_DIR="$HOME/.zen/native-messaging-hosts"
fi

MANIFEST_NAME="org.brp.bridge.json"

# ─── Argument parsing ───

UNINSTALL=false
BROWSER="detect"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall)
      UNINSTALL=true
      shift
      ;;
    --browser)
      BROWSER="$2"
      shift 2
      ;;
    --browser=*)
      BROWSER="${1#*=}"
      shift
      ;;
    --help|-h)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--uninstall] [--browser firefox|zen|both]" >&2
      exit 1
      ;;
  esac
done

# ─── Binary check (install only) ───

if [ "$UNINSTALL" = false ]; then
  if [ ! -f "$BINARY" ]; then
    echo "ERROR: Bridge binary not found at $BINARY" >&2
    echo "       Build it first: cd $PROJECT_DIR/bridge && cargo build --release" >&2
    exit 1
  fi
  BINARY_PATH="$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")"
  echo "[install] Binary: $BINARY_PATH"
  if [ ! -x "$BINARY_PATH" ]; then
    chmod +x "$BINARY_PATH"
  fi
fi

# ─── Manifest template check ───

if [ ! -f "$MANIFEST_TEMPLATE" ]; then
  echo "ERROR: Manifest template not found at $MANIFEST_TEMPLATE" >&2
  exit 1
fi

# ─── Detect available browsers ───

detect_browsers() {
  local browsers=""
  if [ -d "/Applications/Firefox.app" ] || [ -d "$HOME/Applications/Firefox.app" ] || command -v firefox >/dev/null 2>&1 || [ -d "$HOME/.mozilla" ]; then
    browsers="$browsers firefox"
  fi
  if [ -d "/Applications/Zen Browser.app" ] || [ -d "/Applications/Zen.app" ] || command -v zen-browser >/dev/null 2>&1 || [ -d "$HOME/.zen" ]; then
    browsers="$browsers zen"
  fi
  echo "$browsers" | xargs  # trim
}

if [ "$BROWSER" = "detect" ]; then
  DETECTED=$(detect_browsers)
  if [ -z "$DETECTED" ]; then
    echo "WARNING: Could not detect Firefox or Zen. Use --browser to specify." >&2
    echo "  $0 --browser firefox" >&2
    exit 1
  fi
  BROWSER="$DETECTED"
  echo "[detect] Found: $BROWSER"
fi

# ─── Install / uninstall helpers ───

install_manifest() {
  local dir="$1"
  local browser_name="$2"

  mkdir -p "$dir"

  if [ "$UNINSTALL" = false ]; then
    # Create manifest with real binary path
    local target="$dir/$MANIFEST_NAME"
    sed "s|PLACEHOLDER_ABSOLUTE_PATH_TO_BRP_BRIDGE_EXECUTABLE|$BINARY_PATH|g" \
      "$MANIFEST_TEMPLATE" > "$target"
    echo "[install] $browser_name → $target"
  else
    local target="$dir/$MANIFEST_NAME"
    if [ -f "$target" ]; then
      rm -f "$target"
      echo "[uninstall] $browser_name ← removed $target"
    else
      echo "[uninstall] $browser_name — not installed (no manifest at $target)"
    fi
  fi
}

# ─── Execute ───

for browser in $BROWSER; do
  case "$browser" in
    firefox)
      install_manifest "$FIREFOX_DIR" "Firefox"
      ;;
    zen)
      install_manifest "$ZEN_DIR" "Zen"
      ;;
    both|detect)
      install_manifest "$FIREFOX_DIR" "Firefox"
      install_manifest "$ZEN_DIR" "Zen"
      ;;
    *)
      echo "ERROR: Unknown browser: $browser. Use firefox, zen, or both." >&2
      exit 1
      ;;
  esac
done

echo ""
if [ "$UNINSTALL" = true ]; then
  echo "✅ Native messaging manifest(s) uninstalled."
else
  echo "✅ Native messaging manifest(s) installed."
  echo "   Next: Load the extension in Firefox/Zen → about:debugging"
  echo "         Then start the bridge: cd $PROJECT_DIR/bridge && cargo run"
fi
