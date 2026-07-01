# BRP Architecture — Unified Bridge Discovery (v0.9)

> Last updated: 2026-07-01

## Overview

BRP uses a **single Bridge** model. The Bridge owns the WebSocket server,
manages browser sessions, and enforces protocol security.

The MCP Adapter uses **Discovery** to find and reuse an already-running Bridge
before spawning a new one. This eliminates the dual-Bridge problem.

```
┌─────────────┐       ┌──────────────────┐       ┌──────────────┐
│  AI Client  │←stdio→│  MCP Adapter     │       │  Firefox     │
│ (Claude etc)│       │                  │       │  Extension   │
└─────────────┘       │  ┌────────────┐  │       └──────┬───────┘
                      │  │ Discovery  │  │              │
                      │  └─────┬──────┘  │              │ WS
                      │        │         │              │
                      │   ┌────┴────┐    │       ┌──────┴───────┐
                      │   ↓         ↓    │       │   Bridge     │
                      │ Found    Not Found │       │ (singleton)  │
                      │   │         │    │       └──────┬───────┘
                      │   │ WS      │ NM │              │
                      │   │ connect  │spawn│              │
                      │   ↓         ↓    │              │
                      └───┴─────────┴────┘──────────────┘
```

## Components

### Discovery (Architecture Layer)

**Responsibilities:**
- Find an already-running Bridge (via lockfile: `{pid, port, token}`)
- Verify the Bridge is alive (PID liveness + port reachability)
- Return the Bridge connection info
- If no Bridge exists, signal the adapter to spawn one

**Does NOT handle:**
- Browser sessions
- Token management
- Recovery
- UI

### Bridge

**Responsibilities:**
- Browser session management (initialize/shutdown/exit)
- Protocol enforcement (capability negotiation, version negotiation)
- Token authentication (all WS connections must present a valid token)
- Browser connection management (extension WS connections)
- Request routing (JSON-RPC → local handle or forward to extension)

**WS Connection Types:**
1. **Extension** (`register`): Firefox extension connects, receives forwarded requests
2. **Client** (`register_client`): MCP adapter connects, sends JSON-RPC directly

### MCP Adapter

**Responsibilities:**
- Discovery (find or spawn Bridge)
- Connect to Bridge (WS or NM transport)
- Forward MCP tool calls as JSON-RPC requests
- Translate responses for AI client

**Does NOT handle:**
- UI
- Auto-install
- Auto-repair

### Recovery Protocol

**Responsibilities:**
- Report observable facts (never inferred causes)
- Provide recovery actions

**Does NOT handle:**
- Bridge Discovery
- Bridge selection
- Runtime Discovery

## Discovery Flow

```
Adapter Start
    │
    ▼
Read lockfile ({pid, port, token})
    │
    ├─ Lockfile exists?
    │   ├─ NO → spawn Bridge (NM fallback)
    │   └─ YES → check PID alive?
    │       ├─ NO → clean stale lockfile, spawn Bridge
    │       └─ YES → check port reachable?
    │           ├─ NO → spawn Bridge
    │           └─ YES → connect via WS as register_client
    │
    ▼
Connected to Bridge (singleton)
```

## Lockfile Format

```json
{
  "pid": 12345,
  "port": 53915,
  "token": "uuid-v4-token"
}
```

- **Path (Windows):** `%LOCALAPPDATA%\brp-bridge\bridge.lock`
- **Path (Linux):** `$XDG_RUNTIME_DIR/brp-bridge.lock`
- **Path (macOS):** `/tmp/brp-bridge-<uid>.lock`
- **Permissions:** 0600 on Unix (user-private)

## Usage Modes

### B1 Auto-Link (Bootstrap)

Firefox extension launches Bridge via `connectNative()`. Bridge:
1. Binds WS on a random port
2. Sends `{port, token}` to extension via stdout (NM format)
3. Writes lockfile with `{pid, port, token}`
4. Extension connects via WS

### Bridge Mode (MCP Adapter)

MCP adapter starts Bridge as a child process. Bridge:
1. Binds WS on configured port (default 9817)
2. Writes lockfile with `{pid, port, token}`
3. Adapter communicates via NM stdin/stdout OR WS

### Discovery Mode (New in v0.9)

MCP adapter discovers an already-running Bridge:
1. Reads lockfile
2. Verifies PID alive + port reachable
3. Connects via WS as `register_client`
4. Sends JSON-RPC requests directly

## Discovery Before Recovery

**Principle:** Recovery Protocol only operates after Discovery has succeeded.

Recovery Protocol assumes:
- The client is already connected to the correct Bridge
- The Bridge is the singleton instance

Recovery Protocol does NOT handle:
- Bridge Discovery
- Bridge Selection
- Runtime Discovery

If Discovery fails, the error is a **Discovery error**, not a Recovery error.
