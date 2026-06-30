# BRP Usage Modes

BRP has two distinct usage modes with different lifecycle models.

## Mode 1: Browser Bootstrap (B1) — v0.4.0+

**Use case**: AI agent drives user's real browser session via Firefox/Zen extension.

**Flow**:

```
Firefox Extension
  → connectNative() spawns bridge as child process (bootstrap mode)
  → bridge binds random WS port (127.0.0.1:0)
  → bridge sends {port, token} via stdout
  → extension connects WebSocket
  → AI agent (via MCP adapter) connects to same bridge
```

**Characteristics**:
- Bridge is child process of browser, dies when browser closes
- Random WS port → **multi-instance support**
- Token delivered via stdout, no file
- No manual configuration needed

**Multi-instance support**:

| Scenario | Works? |
|---|---|
| Multiple tabs | ✅ (shared background) |
| Multiple windows (same profile) | ✅ (shared background) |
| Firefox + Zen simultaneously | ✅ (each spawns own bridge) |
| Firefox + Firefox Dev | ✅ (each spawns own bridge) |
| Multiple profiles | ✅ (each spawns own bridge) |

### Known trade-offs

- **Native Port kept open during WS session**: minor resource overhead, necessary to keep bridge alive on Windows (port.disconnect() kills the process)
- **Extension crash may temporarily leave orphan bridge**: relies on OS process cleanup; the bridge's 30-second WS connection timeout also helps
- **Reconnect restarts entire bridge**: acceptable for loopback (WS is 127.0.0.1), optimization deferred to v0.4.2+

## Mode 2: Standalone Bridge — v0.3.0+

**Use case**: MCP client (Claude Desktop, Codex) drives browser without B1 auto-link.

**Flow**:

```
MCP Client (Claude Desktop)
  → spawns MCP adapter (Python)
  → spawns bridge in bridge mode (fixed port 9817)
  → extension manually configured with token
  → extension connects WebSocket to 127.0.0.1:9817
```

**Characteristics**:
- Bridge is independent process, survives browser restart
- Fixed WS port (default 9817, configurable via `BRP_WS_ADDR`)
- Token written to file, user must copy to extension Options
- Manual configuration required
- **B2 Multi-token**: Master token can issue/revoke client tokens via `token.issue`/`token.revoke`/`token.list` (see [API.md](API.md) §12)

**Multi-instance limitation**:
- Multiple MCP clients conflict on port 9817
- Workaround: set `BRP_WS_ADDR=127.0.0.1:9818` for second client
- **v0.4.1 plan**: bridge mode may support `--port=0` random port

## Which mode should I use?

| If you want... | Use |
|---|---|
| Browser auto-connect, no manual config | B1 (Mode 1) |
| MCP client without browser extension | Standalone (Mode 2) |
| Both browser + MCP client | B1 (MCP adapter connects to B1 bridge) |

## Migration from v0.3.x

v0.3.x users on Standalone mode: no change needed, v0.4.0 preserves Standalone mode.

v0.3.x users wanting B1: run `install.sh`/`install.ps1` (required for native messaging), then reload extension. B1 activates automatically.
