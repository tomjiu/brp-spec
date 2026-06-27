# BRP MVP — Browser Runtime Protocol

MVP implementation of the Browser Runtime Protocol (BRP): a Firefox/Zen extension + Rust Bridge that enables AI agents to interact with the user's real browser session.

## Architecture

```
AI Client (MCP/Claude/Codex)
    │
    │  stdin/stdout (JSON-RPC 2.0 + Native Messaging format)
    │
    ▼
Rust Bridge (brp-bridge)
    │
    │  WebSocket (ws://127.0.0.1:9817)
    │
    ▼
Firefox Extension (background.js + content scripts)
    │
    │  browser.tabs / browser.webNavigation / DOM API
    │
    ▼
User's Real Browser Session (cookies, logins, tabs)
```

The Bridge handles protocol lifecycle (initialize/shutdown/exit) locally and forwards all other requests (navigation, element interaction, screenshots) to the Firefox Extension via WebSocket.

## Project Structure

```
brp-mvp/
├── bridge/                     # Rust Bridge
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs             # Entry point: stdin/stdout + WebSocket server
│       ├── protocol/
│       │   ├── message.rs      # JSON-RPC 2.0 message types (RFC0001 §9)
│       │   └── session.rs      # Session lifecycle & capability negotiation (RFC0001 §10-11)
│       └── transport/
│           └── native.rs       # Native Messaging format (4-byte length + JSON)
│
├── extension/                  # Firefox Extension
│   ├── manifest.json           # Manifest V2 (Firefox/Zen compatible)
│   ├── background/
│   │   └── background.js       # WebSocket client, request routing, event forwarding
│   └── content/
│       ├── itree.js            # Interaction Tree builder (DOM → structured tree)
│       └── content.js          # Action handlers (click, type, fill, scroll)
│
└── native-manifest/
    └── org.brp.bridge.json     # Firefox Native Messaging host manifest
```

## Build

### Rust Bridge

```bash
cd bridge
cargo build --release
```

The binary will be at `bridge/target/release/brp-bridge`.

### Firefox Extension

No build step required. Load directly:

1. Open Firefox / Zen → `about:debugging`
2. Click "This Firefox" → "Load Temporary Add-on"
3. Select `extension/manifest.json`

For permanent installation, sign via [AMO](https://addons.mozilla.org/developers/) or use `web-ext build`.

## Setup

### 1. Install the Extension

Load the extension in Firefox/Zen as described above. The extension will try to connect to `ws://127.0.0.1:9817` (the Bridge's WebSocket server).

### 2. Register Native Messaging Host

Copy the native manifest to Firefox's native messaging directory:

**Linux:**
```bash
cp native-manifest/org.brp.bridge.json ~/.mozilla/native-messaging-hosts/
# For Zen:
cp native-manifest/org.brp.bridge.json ~/.zen/native-messaging-hosts/
```

**macOS:**
```bash
cp native-manifest/org.brp.bridge.json ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/
```

**Windows:**
Add registry key:
```
HKCU\Software\Mozilla\NativeMessagingHosts\org.brp.bridge
```
with value pointing to the full path of `native-manifest/org.brp.bridge.json`.

### 3. Update the Manifest Path

Edit `native-manifest/org.brp.bridge.json` and replace `PLACEHOLDER_ABSOLUTE_PATH_TO_BRP_BRIDGE_EXECUTABLE` with the absolute path to your compiled `brp-bridge` binary.

### 4. Configure AI Client

Add the Bridge as an MCP server in your AI client:

```json
{
  "mcpServers": {
    "brp-bridge": {
      "command": "/absolute/path/to/brp-bridge",
      "env": {
        "BRP_WS_ADDR": "127.0.0.1:9817",
        "RUST_LOG": "info"
      }
    }
  }
}
```

## Protocol

The Bridge implements BRP RFC0001 (Draft). Key features:

- **JSON-RPC 2.0** message model (Request / Response / Notification / Error)
- **Session lifecycle**: Disconnected → Connecting → Authenticating → Ready → Closing → Closed
- **Capability negotiation**: features + actions intersection
- **Sequence numbering**: all notifications carry a monotonic sequence number
- **Selector fallback chain**: nodeId → role → css → xpath → coordinate → text

### Supported Actions (MVP)

| Method | Description |
|--------|-------------|
| `initialize` | Negotiate session, version, capabilities |
| `shutdown` / `exit` | Clean session termination |
| `browser.list` | List all connected browsers |
| `tab.list` | List all open tabs |
| `tab.open` | Open new tab at URL |
| `tab.close` | Close a tab |
| `tab.select` | Switch to a tab |
| `page.navigate` | Navigate to URL |
| `page.getInteractionTree` | Get structured Interaction Tree |
| `page.screenshot` | Capture visible tab screenshot |
| `page.goBack` | Navigate back in history |
| `page.goForward` | Navigate forward in history |
| `page.reload` | Reload the current page |
| `page.waitForSelector` | Wait for a CSS selector to appear |
| `element.click` | Click an element |
| `element.type` | Type text character by character |
| `element.fill` | Set input value directly |
| `element.scroll` | Scroll an element into view |
| `element.hover` | Hover mouse over an element |
| `element.select` | Select option in a dropdown |
| `element.getAttribute` | Get an attribute or property value |
| `keyboard.press` | Press a key or key combination |
| `script.execute` | Execute JavaScript in page context |

### Notifications

| Event | Trigger |
|-------|---------|
| `notification/navigationStarted` | Page navigation begins |
| `notification/navigationCompleted` | Page navigation finishes |
| `notification/domChanged` | DOM mutation detected (debounced) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRP_WS_ADDR` | `127.0.0.1:9817` | WebSocket server address for Extension |
| `BRP_TOKEN_ADDR` | `127.0.0.1:9818` | HTTP server address for auth token (WS port + 1) |
| `BRP_TOKEN_FILE` | Platform-specific | Path to write auth token file |
| `BRP_STANDALONE` | `0` | Set to `1` to run Bridge as pure WS server (no stdin/stdout) |
| `RUST_LOG` | `info` | Log level (error/warn/info/debug/trace) |

## Security

See [`SECURITY.md`](SECURITY.md) for the full threat model, security invariants, and known risks, and [`docs/SECURITY-ARCHITECTURE-DECISIONS.md`](docs/SECURITY-ARCHITECTURE-DECISIONS.md) for the v0.3.0 hardening roadmap.

- **Token Authentication**: The Bridge generates a UUID v4 token on startup, writes it to a platform-specific file path, and serves it via a local HTTP endpoint. The Extension fetches the token and includes it in the registration handshake. Connections without a valid token are rejected.
- **Token File Locations**:
  - Windows: `%APPDATA%\brp-bridge\token`
  - Linux/macOS: `~/.brp-bridge-token`
  - Override with `BRP_TOKEN_FILE` environment variable
- **Restricted Pages**: Content scripts cannot be injected into `about:*`, `chrome:*`, `moz-extension:*`, and similar restricted pages. The Extension detects this and returns a `BRP_RESTRICTED_PAGE` error.
- **Script Execution**: `script.execute` uses `new Function()` instead of `eval()` for better isolation, with a 1MB size limit.

## Multi-Browser Support

Multiple browsers (Firefox, Zen) can connect to the same Bridge simultaneously. Each browser registers with a unique `browserId` (auto-detected). Requests can target a specific browser by including a `browserId` parameter:

```json
{"jsonrpc": "2.0", "id": 1, "method": "tab.list", "params": {"browserId": "zen"}}
```

Use `browser.list` to see all connected browsers.

## Development

```bash
# Run bridge with debug logging
cd bridge
cargo run

# In another terminal, test with a JSON-RPC client:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"0.1.0","clientInfo":{"name":"test","version":"0.1"},"capabilities":{"features":["interactionTree","events"]}}}' | ./target/debug/brp-bridge
```

## Testing

```bash
# Quick smoke test (no Extension needed):
# Sends initialize/shutdown/exit via stdin, verifies Bridge responses
cd bridge
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"0.1.0"}}' | cargo run

# Full E2E test requires Python 3:
# 1. Starts Bridge with WS server
# 2. Connects a simulated Extension via WebSocket
# 3. Sends requests and verifies end-to-end flow
python tests/test_e2e.py
```

E2E verified pipeline: `AI Client → stdin(Native Messaging) → Bridge → WebSocket → Extension → WebSocket → Bridge → stdout → AI Client`

## License

MIT
