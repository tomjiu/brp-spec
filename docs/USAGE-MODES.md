# BRP Usage Modes

BRP has two usage modes, unified by **Bridge Discovery** (v0.9+).

## Mode 1: Browser Bootstrap (B1) — v0.4.0+

**Use case**: AI agent drives user's real browser session via Firefox/Zen extension.

**Flow**:

```
Firefox Extension
  → connectNative() spawns bridge as child process (bootstrap mode)
  → bridge binds random WS port (127.0.0.1:0)
  → bridge sends {port, token} via stdout
  → extension connects WebSocket
  → lockfile written: {pid, port, token}
  → MCP adapter discovers bridge via lockfile
  → MCP adapter connects via WS as register_client
```

**Characteristics**:
- Bridge is child process of browser, dies when browser closes
- Random WS port → multi-instance support
- Token delivered via stdout, no file
- No manual configuration needed
- **v0.9+**: MCP adapter discovers and reuses B1 Bridge

## Mode 2: Standalone Bridge — v0.3.0+

**Use case**: MCP client alone; bridge runs independently.

**Flow**:

```
MCP Client (Claude Desktop)
  → spawns MCP adapter (Python)
  → adapter tries Discovery → no lockfile found
  → adapter spawns bridge in bridge mode (fallback)
  → bridge binds WS port (default 9817)
  → lockfile written: {pid, port, token}
  → extension manually configured with token
  → extension connects WebSocket
```

**Characteristics**:
- Bridge is independent process, survives browser restart
- Fixed WS port (default 9817, configurable via `BRP_WS_ADDR`)
- Token written to file, user must copy to extension Options
- **v0.9+**: Discovery tries to find existing bridge before spawning

## Mode 3: Unified Discovery (new in v0.9)

Both modes now share a **single Bridge singleton**. The MCP adapter always
discovers before spawning:

```
Adapter Start
    ↓
Read lockfile ({pid, port, token})
    ├─ PID alive + port reachable → WS connect as register_client
    └─ No lockfile or stale → spawn new bridge (NM fallback)
```

This eliminates the "two Bridge" problem from v0.8.

## Which mode should I use?

| If you want... | Use |
|---|---|
| Browser auto-connect, no manual config | B1 (Mode 1) |
| MCP client without browser extension | Standalone (Mode 2) |
| Both browser + MCP client | B1 — adapter discovers it automatically |
