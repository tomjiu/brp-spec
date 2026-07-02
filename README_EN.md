[中文](README.md) · [AMO Store](https://addons.mozilla.org/firefox/addon/brp-bridge-extension/) · [API Docs](docs/API.md)

<br>

> 🔌 **BRP** — Browser Runtime Protocol. Give AI assistants (Cursor, Claude, Codex) real browser control.

---

## Quick Start

### Install

**From Firefox Add-ons Store** (Recommended)

Visit the [AMO listing](https://addons.mozilla.org/firefox/addon/brp-bridge-extension/) and click "Add to Firefox".

**Manual Install**

1. Download `brp-extension-v*.xpi` from the latest [Release](https://github.com/tomjiu/brp-spec/releases)
2. Drag the `.xpi` into Firefox

### Bridge Setup

**Windows:**

```powershell
.\install.ps1
```

**Linux / macOS:**

```bash
bash install.sh
```

The install script handles: Bridge compilation → Native Messaging registration → done.

### Connect AI Client (MCP)

Add to your MCP client's config:

```json
{
  "mcpServers": {
    "brp": {
      "command": "python",
      "args": ["-X", "utf8", "/path/to/brp-spec/adapter/brp_mcp_adapter.py"],
      "env": {
        "BRP_WS_ADDR": "127.0.0.1:9817"
      }
    }
  }
}
```

Reconnect MCP and your AI can control the browser. 21 tools available:

| Category | Tools |
|----------|-------|
| Tabs | `tab_list` `tab_open` `tab_close` `tab_select` |
| Pages | `navigate` `reload` `go_back` `go_forward` `screenshot` `snapshot` |
| Elements | `click` `fill` `type` `scroll` `hover` `select` `get_attribute` |
| Keyboard | `key_press` |
| Wait | `wait_for_selector` |

---

## Features

- **Full tab management** — open, close, switch, list all tabs
- **Page operations** — navigate, reload, back/forward, screenshot, DOM interaction tree
- **Element interaction** — CSS/XPath/text/nodeId selectors, click, fill, scroll, hover
- **Keyboard simulation** — key combinations (Control+A, Alt+F4, etc.)
- **Security** — domain allowlist/blacklist, sensitive data redaction, permission dialogs
- **Multi-browser** — one Bridge serves Firefox + Zen Browser simultaneously
- **Auto-discovery** — MCP adapter finds existing Bridge, no manual management

---

## Architecture

```
AI Client (MCP/Claude/Cursor)
    │  stdin/stdout (JSON-RPC 2.0)
    ▼
MCP Adapter (brp_mcp_adapter.py)
    │  WebSocket / Native Messaging
    ▼
Rust Bridge (brp-bridge)
    │  WebSocket (127.0.0.1:9817)
    ▼
Firefox Extension (TypeScript)
    │  WebExtension API
    ▼
User's Real Browser (cookies, sessions, tabs)
```

---

## Development

### Requirements

- **Rust** ≥ 1.85
- **Node.js** ≥ 20
- **Python** ≥ 3.10 (MCP adapter)

### Build

```bash
# Bridge
cd bridge && cargo build --release

# Extension
cd extension && npm ci && npm run build

# Dev mode: load extension
# Firefox → about:debugging → Load Temporary Add-on → select extension/manifest.json
```

### Test

```bash
# Bridge unit tests (67+ tests)
cd bridge && cargo test

# Extension unit tests (277 tests)
cd extension && npm test

# Full chain test
python -X utf8 test_brp_chain.py
```

### Project Structure

```
brp-spec/
├── bridge/           # Rust Bridge — JSON-RPC routing, WebSocket server
├── extension/        # Firefox Extension — TypeScript → esbuild
├── adapter/          # MCP Adapter — bridges AI client to Bridge
├── docs/             # Protocol docs, architecture
├── install.ps1       # Windows one-click install
└── install.sh        # Linux/macOS one-click install
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRP_WS_ADDR` | `127.0.0.1:9817` | WebSocket server address |
| `BRP_AUTH_TOKEN` | Auto-generated | Authentication token |
| `BRP_ALLOW_SCRIPT_EXECUTE` | `0` | Set to `1` to enable script execution |
| `BRP_STANDALONE` | `0` | Set to `1` for pure WS mode |
| `RUST_LOG` | `info` | Log level |

---

## Security

See [SECURITY.md](SECURITY.md)

- ✅ Mandatory token authentication
- ✅ Domain allowlist/blacklist
- ✅ URL scheme guard — blocks `javascript:` `file:` etc.
- ✅ Input validation — types, lengths, ranges
- ✅ Sensitive data redaction — passwords, credit cards → `[REDACTED]`
- ✅ Script execution disabled by default
- ✅ Connection rate limiting

---

## License

MIT
