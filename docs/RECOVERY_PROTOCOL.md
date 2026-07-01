# BRP Recovery Protocol (v0.9)

> Last updated: 2026-07-01

## Principle

```
The protocol reports observable facts.
It never reports inferred causes.
```

The protocol reports **what happened** — not **why** it happened.

### Correct

```
extension_not_connected
```

### Wrong (inferred causes)

```
extension_missing
extension_disabled
native_host_broken
```

These are inferences. The protocol cannot know if the extension is disabled,
uninstalled, or if the native host is broken. It only knows the extension
is not connected.

## Discovery Before Recovery

Recovery Protocol operates **only after** Discovery has succeeded.

```
1. Discovery → find and connect to Bridge
2. Protocol  → initialize, negotiate, operate
3. Recovery  → report facts, suggest actions (if something goes wrong)
```

Recovery does NOT handle:
- Bridge Discovery
- Bridge Selection
- Runtime Discovery

## Recovery Reasons (v0.9 — Minimal Set)

Only two standard reasons are defined. Do not add more before API freeze.

### 1. `extension_not_connected`

**Meaning:** No browser extension is connected to the Bridge.

**When:** The client sent a request that requires an extension (e.g.
`page.navigate`), but no extension WS connection exists.

**Recovery Action:**

```
ensure_extension_installed_and_enabled
```

**AI behavior:** Guide the user to:
1. Install the BRP extension in Firefox
2. Ensure the extension is enabled
3. Ensure Firefox is running

### 2. `version_mismatch`

**Meaning:** The protocol version negotiated between client and Bridge
does not match the extension's version.

**When:** The negotiated version is incompatible with the connected extension.

**Recovery Action:**

```
upgrade_components
```

**AI behavior:** Guide the user to:
1. Update the BRP extension to the latest version
2. Update the Bridge to the latest version
3. Restart both components

## Error Response Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "No extension connected",
    "data": {
      "errorCode": "BRP_EXTENSION_DISCONNECTED",
      "category": "TARGET",
      "retriable": true,
      "recoveryHint": "ensure_extension_installed_and_enabled"
    }
  }
}
```

## Error Categories

| Category | Meaning |
|----------|---------|
| `AUTH` | Authentication failure (invalid token) |
| `CAPABILITY` | Method not supported or not negotiated |
| `PERMISSION` | Action blocked by permission policy |
| `TARGET` | Extension/tab/target not available |
| `INTERNAL` | Internal Bridge error |

## Not a Recovery Concern

The following are **Discovery errors**, not Recovery errors:

- Bridge not found (no lockfile, PID dead, port unreachable)
- Bridge spawn failure
- WS connection refused

These are handled by the Discovery layer, not the Recovery Protocol.
