#!/usr/bin/env bash
set -euo pipefail

# BRP E2E Test Runner
# Launches Bridge + Extension, runs Playwright tests against Firefox.
#
# Prerequisites:
#   1. Rust toolchain (cargo)
#   2. Node.js 22+
#   3. Firefox installed
#   4. BRP native manifest installed (see native-manifest/)
#
# Usage: ./run_e2e.sh [firefox-path]
#   firefox-path: optional path to Firefox binary (default: system firefox)

FIREFOX="${1:-firefox}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRP_PORT="9817"

echo "=== BRP E2E Test Runner ==="
echo "Firefox: $FIREFOX"
echo "Port: $BRP_PORT"

# ── 1. Build Bridge ──
echo ""
echo "--- Building Bridge ---"
cd "$SCRIPT_DIR/bridge"
cargo build --release
BRIDGE_BIN="$SCRIPT_DIR/bridge/target/release/brp-bridge"
echo "Bridge: $BRIDGE_BIN"

# ── 2. Build Extension ──
echo ""
echo "--- Building Extension ---"
cd "$SCRIPT_DIR/extension"
npm ci --silent
npm run prebuild
npm run build
EXT_DIR="$SCRIPT_DIR/extension/dist"
echo "Extension: $EXT_DIR"

# ── 3. Generate auth token ──
BRP_TOKEN="e2e-test-token-$(date +%s)"
echo "Token: $BRP_TOKEN"

# ── 4. Start Bridge (Bridge mode — MCP adapter) ──
echo ""
echo "--- Starting Bridge ---"
BRP_AUTH_TOKEN="$BRP_TOKEN" \
BRP_MASTER_TOKEN="$BRP_TOKEN" \
"$BRIDGE_BIN" bridge &
BRIDGE_PID=$!
echo "Bridge PID: $BRIDGE_PID"

# Wait for Bridge to be ready
for i in $(seq 1 10); do
    if nc -z 127.0.0.1 "$BRP_PORT" 2>/dev/null; then
        echo "Bridge is listening on $BRP_PORT"
        break
    fi
    sleep 0.5
done

# ── 5. Load extension in Firefox ──
echo ""
echo "--- Loading Extension in Firefox ---"
# Create a temporary profile
TMP_PROFILE=$(mktemp -d)
echo "Temporary profile: $TMP_PROFILE"

# Start Firefox with the extension loaded via temporary profile
# This uses Firefox's --start-debugger-server for WebDriver
# Playwright handles the loading

# ── 6. Run Playwright E2E tests ──
echo ""
echo "--- Running E2E Tests ---"
cd "$SCRIPT_DIR"
npx playwright test tests/integration/e2e-*.spec.ts \
    --project=firefox \
    --reporter=list \
    "$@"
TEST_RESULT=$?

# ── 7. Cleanup ──
echo ""
echo "--- Cleanup ---"
kill "$BRIDGE_PID" 2>/dev/null || true
rm -rf "$TMP_PROFILE" 2>/dev/null || true

echo ""
if [ "$TEST_RESULT" -eq 0 ]; then
    echo "✅ All E2E tests passed!"
else
    echo "❌ E2E tests failed (exit code: $TEST_RESULT)"
fi

exit "$TEST_RESULT"
