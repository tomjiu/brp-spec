# BRP v0.3.0 Security Hardening Plan

> Consolidated from multiple security audits, architecture reviews, and implementation discussions.
> Date: 2026-06-27 | Status: Ready for Implementation

---

## Current State (v0.2.0)

Already implemented:

- WS token authentication (UUID v4, file + HTTP endpoint)
- Multi-browser support (HashMap connection pool, registration protocol, browserId routing)
- RFC0002 Core Actions (hover/select/getAttribute/keyboard.press/navigation history/reload/waitForSelector)
- Restricted page detection (`about:*`, `chrome:*`, `moz-extension:*` return `BRP_RESTRICTED_PAGE`)
- Reconnection with jitter (+/-25%) and auth-failure backoff (5x base, max 30s)
- Content script hardening (`Function` constructor instead of `eval`, 1MB size limit, `document.body` guard)
- `sendMessage` error suppression (`.catch()` on all background notifications)
- E2E test: 10/10 passing with token auth

---

## Phase 1: Token Distribution Overhaul (P0 - Critical)

**Problem**: Current HTTP token server (`Access-Control-Allow-Origin: *`) allows any webpage to steal the auth token via `fetch("http://127.0.0.1:9818/token")`, enabling DNS rebinding and cross-origin token theft.

**Solution**: Replace HTTP token server with one-time challenge file.

### Changes

| File | Change | Detail |
|------|--------|--------|
| `bridge/src/main.rs` | Remove `run_token_server()` | Delete entire HTTP token server function and `BRP_TOKEN_ADDR` logic |
| `bridge/src/main.rs` | Add `generate_challenge()` | Generate UUID v4 challenge, write to `BRP_TOKEN_FILE` (or platform default), return challenge string |
| `bridge/src/main.rs` | Update registration validation | Accept `challenge` field in register params, verify against stored challenge, invalidate after first use (single-shot) |
| `bridge/src/main.rs` | Add challenge expiry | Challenge expires after 60s if unused, Bridge generates new one on next connection attempt |
| `extension/background/background.js` | Remove `fetchAuthToken()` HTTP fetch | Replace with file-based challenge reading |
| `extension/background/background.js` | Update `connect()` registration | Read challenge from file, send as `challenge` param instead of `token` |
| `tests/test_e2e.py` | Update registration | Read challenge file, send in registration message |

### Rust Unit Tests to Add

```
test_challenge_generation()    — Verify UUID v4 format, uniqueness
test_challenge_file_written()  — Verify file exists, correct permissions
test_challenge_single_use()    — Verify challenge invalidated after first registration
test_challenge_expiry()        — Verify challenge rejected after timeout
```

### Outcome

- Zero network attack surface for token distribution
- DNS rebinding impossible (no HTTP endpoint)
- Cross-origin theft impossible (no CORS, no network)
- Simpler codebase (remove ~50 lines of HTTP server)

---

## Phase 2: Extension Defense-in-Depth (P1 - High)

**Problem**: Extension blindly executes all Bridge commands. No validation layer between Bridge and page content. A compromised Bridge or stolen token gives full browser control.

### Design Principles

1. **Firefox internal APIs (bookmarks/history/passwords) are off by default** — these expose user's most sensitive data and require explicit permission escalation.
2. **Agent scope constraint** — the agent should only operate on what was explicitly requested. Prevent autonomous navigation to unrelated domains ("don't stray").
3. **User-customizable domain blocklist** — users define which domains are off-limits, not a hardcoded list.
4. **Firefox built-in autofill is safe** — Firefox's password manager fills forms without exposing password values to the AI agent. No restriction needed.

### 2A: Firefox Internal API Permission Gate

**Default: BLOCKED.** These capabilities require the user to explicitly enable them in the extension's options page (`about:addons` → BRP Extension → Preferences) or via runtime permission grant.

| Capability | Risk | Default | Permission Key |
|------------|------|---------|----------------|
| `bookmarks.list` / `bookmarks.search` | Expose user's bookmarked sites (banking, private) | BLOCKED | `brp:bookmarks` |
| `history.search` / `history.list` | Expose browsing patterns, visited sites | BLOCKED | `brp:history` |
| `passwords.list` / `passwords.get` | Expose stored credentials | BLOCKED | `brp:passwords` |
| `cookies.get` / `cookies.list` | Expose session tokens, auth cookies | BLOCKED | `brp:cookies` |
| `downloads.list` / `downloads.open` | Expose downloaded files | BLOCKED | `brp:downloads` |

**Implementation:**

| File | Change |
|------|--------|
| `extension/background/background.js` | Add `permissionGates` map: method → permission key |
| `extension/background/background.js` | Add `checkPermission(method)` that reads from extension storage |
| `extension/background/background.js` | In `handleRequest()`, gate new API methods behind permission check |
| `extension/options/options.html` (new) | Simple options page with toggle switches for each permission |
| `extension/options/options.js` (new) | Read/write permission state to `browser.storage.local` |
| `extension/manifest.json` | Add `"options_ui"` and `"storage"` permission |

**Permission grant flow:**
```
AI Agent requests bookmarks.list
  → Extension checks permission gate
  → BLOCKED (default)
  → Returns error: { code: "BRP_PERMISSION_REQUIRED", 
                     message: "Bookmarks access requires user approval",
                     recoveryHint: "Enable in BRP Extension settings" }
  → Agent informs user
  → User opens about:addons → BRP Extension → toggles "Allow bookmarks access"
  → Next request succeeds
```

**Note:** Firefox built-in password autofill (browser fills form fields automatically) does NOT require permission gating. The autofill mechanism is browser-native — it fills `type="password"` inputs without exposing the plaintext value to JavaScript or the AI agent. The `element.fill` action sets values programmatically (visible to JS), but `brp_snapshot`/ITree already redacts password field values (see Phase 4).

### 2B: Agent Scope Constraint ("Don't Stray")

**Problem**: AI agent given a task on `example.com` could autonomously navigate to `bank.com`, `github.com/settings`, etc. The agent should stay within the scope of its assigned task.

**Implementation:**

| File | Change |
|------|--------|
| `extension/background/background.js` | Track `originDomain` from the initial `page.navigate` or current active tab |
| `extension/background/background.js` | Add `isStrayNavigation(url)` — checks if target domain differs from origin domain |
| `extension/background/background.js` | When stray detected on `page.navigate`, log warning but allow (not hard-block) |
| `bridge/src/main.rs` | Add `strayNavigationCount` to session stats for auditability |

**This is a soft constraint (audit + log), not a hard block.** Hard blocking navigation would break legitimate workflows (e.g., OAuth flows that redirect to external providers). The constraint serves as:
- Audit trail for debugging
- Signal for MCP adapter to inform the AI client
- Foundation for future user-configurable strictness levels

### 2C: User-Customizable Domain Blocklist

**Default: empty.** Users add domains they want to protect.

| File | Change |
|------|--------|
| `extension/options/options.html` | Add domain blocklist input (add/remove domains) |
| `extension/background/background.js` | Read blocklist from `browser.storage.local` |
| `extension/background/background.js` | Update `sendToContentScript()` to check blocklist before `script.execute` and `element.fill` |

**Behavior on blocked domain:**
- `script.execute` → `BRP_USER_BLOCKED_DOMAIN` error
- `element.fill` → `BRP_USER_BLOCKED_DOMAIN` error  
- All other actions (click, navigate, snapshot, scroll, getAttribute) → **allowed**

**Rationale:** Blocking ALL actions on a domain is too aggressive. Users may want to browse (navigate, snapshot, click) on blocked domains but prevent the AI from injecting code or filling forms.

### 2D: script.execute Capability Gate

| File | Change |
|------|--------|
| `bridge/src/main.rs` | Read `BRP_ENABLE_SCRIPT_EXECUTE` env var (default `0`) |
| `bridge/src/main.rs` | When disabled, reject `script.execute` with `BRP_FEATURE_DISABLED` error |
| `extension/background/background.js` | Read env via Bridge capability response; hide `script.execute` from capabilities when disabled |
| `adapter/brp_mcp_adapter.py` | Conditionally register `brp_execute` tool based on capability check |
| `extension/content/content.js` | Already has size limit (1MB); add result size limit (truncate responses > 256KB) |

### Outcome

- Firefox internal APIs (bookmarks/history/passwords/cookies) locked behind explicit user permission
- Agent scope tracked and audited (soft constraint for now)
- Users control which domains are off-limits via extension settings
- `script.execute` off by default, explicit env var opt-in
- Firefox native autofill untouched (safe by design — passwords never exposed to JS)
- Three independent defense layers: Bridge gate → Extension permission → User blocklist

---

## Phase 3: Input Validation Hardening (P1 - High)

**Problem**: No validation on URLs, timeouts, tab IDs, or selector lengths. Malformed inputs could cause crashes, file:// access, or resource exhaustion.

| Validation | File | Rule |
|------------|------|------|
| `page.navigate` URL scheme | `extension/background/background.js` | Only `http:` and `https:` allowed. Reject `file:`, `chrome:`, `about:`, `javascript:`, `data:` with `BRP_FORBIDDEN_SCHEME` |
| `waitForSelector.timeout` | `extension/content/content.js` | Hard cap at 60000ms. Values above cap are clamped. |
| `tabId` range | `extension/background/background.js` | Must be positive integer, reject negative/NaN/non-number |
| `pageIdx` range | `extension/background/background.js` | Must be non-negative integer |
| Selector length | `extension/background/background.js` | Max 4096 chars for CSS/XPath selectors |
| `element.select` values | `extension/content/content.js` | Max 100 values in array |
| `keyboard.press` key | `extension/content/content.js` | Max 64 chars, must contain at least one non-modifier key |

### Rust Unit Tests to Add

```
test_navigate_scheme_validation()  — http/https pass, file/chrome/about fail
test_timeout_clamping()            — values > 60000 clamped
test_tabid_validation()            — negative/NaN rejected
test_selector_length_limit()       — > 4096 chars rejected
```

---

## Phase 4: ITree Privacy & Size Controls (P2 - Medium)

**Problem**: ITree can leak passwords, tokens, and credit card numbers. Large pages can generate massive trees that overwhelm the WS channel.

### 4A: Sensitive Value Redaction

| File | Change |
|------|--------|
| `extension/content/itree.js` | Add `redactSensitiveValue(el)` function |

**Redaction rules:**
```javascript
function redactSensitiveValue(el) {
  // Always redact password fields
  if (el.type === "password") return "[REDACTED]";

  // Redact based on field name/id/placeholder keywords
  const sensitive = ["token", "otp", "2fa", "mfa", "secret",
                     "password", "passwd", "pin", "cvv", "cvc",
                     "card", "credit", "ssn", "social"];
  const attrs = [el.name, el.id, el.placeholder, el.ariaLabel].join(" ").toLowerCase();
  if (sensitive.some(kw => attrs.includes(kw))) return "[REDACTED]";

  return el.value;
}
```

Apply in `buildNode()` when collecting input values.

### 4B: Size Limits

| Limit | Value | Behavior |
|-------|-------|----------|
| `maxNodes` | 2000 | Stop building after N nodes, set `truncated: true` |
| `maxDepth` | 30 | Stop recursing beyond depth, children become `[]` |
| `maxTextLength` | 200 | Truncate text/name attributes beyond this |
| `maxTotalBytes` | 512KB | If serialized JSON exceeds, trim children from deepest nodes |

Add to ITree response:
```json
{
  "truncated": true,
  "nodeCount": 2000,
  "maxNodes": 2000,
  "reason": "maxNodes reached"
}
```

### 4C: DOM Node Cache Lifecycle

| File | Change |
|------|--------|
| `extension/content/itree.js` | Clear `nodeIdMap` at start of each `buildInteractionTree()` call |
| `extension/content/itree.js` | Use revision counter: each build increments revision, stale nodeIds from previous revision are invalid |

This ensures no strong references persist across page snapshots. Content script destruction on navigation already handles full cleanup.

---

## Phase 5: Testing & Documentation (P2 - Medium)

### Rust Unit Tests

Create `bridge/src/tests.rs` (or inline `#[cfg(test)] mod tests`):

```
// Token/Challenge
test_challenge_format()
test_challenge_file_permissions()
test_challenge_single_use()
test_challenge_timeout()

// Protocol
test_initialize_handshake()
test_browser_list_empty()
test_browser_list_with_connections()

// Forwarding
test_browserid_routing()
test_browserid_stripped_from_forward()
test_no_extension_error()
test_timeout_error()

// Input validation (if validated in Bridge)
test_navigate_scheme_check()
test_tabid_range_check()
```

### E2E Test Updates

| Test | Addition |
|------|----------|
| `test_e2e.py` | Add challenge-based registration |
| `test_e2e.py` | Add sensitive domain block test |
| `test_e2e.py` | Add script.execute disabled test |
| `test_e2e.py` | Add URL scheme validation test |
| `test_e2e.py` | Add ITree redaction test |

### Documentation

| File | Change |
|------|--------|
| `SECURITY.md` | New file: threat model, implemented protections, known risks, hardening roadmap |
| `README.md` | Update Security section, link to SECURITY.md, document `BRP_ENABLE_SCRIPT_EXECUTE` env var |

---

## Phase 6: Bridge Code Modularization (P3 - Low, Future)

Not urgent. Current main.rs (~500 lines) is manageable. Refactor when it exceeds ~1000 lines.

**Target structure:**
```
bridge/src/
  main.rs          — Entry point, wiring
  transport/
    native.rs      — Stdio Native Messaging (existing)
    websocket.rs   — WS server (extract from main.rs)
  protocol/
    message.rs     — JSON-RPC types (existing)
    session.rs     — Session lifecycle (existing)
    challenge.rs   — Challenge generation/validation (new)
  router.rs        — Request routing, browserId dispatch (extract from main.rs)
  config.rs        — Env vars, defaults (new)
  tests.rs         — Unit tests (new)
```

---

## Implementation Order Summary

```
Phase 1 (P0) ──→ Phase 2A + 2B (P1) ──→ Phase 3 (P1) ──→ Phase 4 (P2) ──→ Phase 5 (P2) ──→ Phase 6 (P3)
 Challenge        Domain blocklist       URL scheme        ITree redact     Rust tests         Modularize
 Remove HTTP      script.execute gate    Timeout cap       Size limits      E2E updates        refactor
 Single-use       Result size limit      Selector limit    DOM cleanup      SECURITY.md
```

**Estimated effort:** Phases 1-5 in one focused session (~4-5 hours). Phase 6 in a separate refactoring session.

---

## Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| One-time challenge over HTTP token server | Eliminates network attack surface entirely; simpler code; no DNS rebinding possible |
| Firefox internal APIs (bookmarks/history/passwords) blocked by default | These expose user's most private data; must require explicit opt-in via extension settings |
| Agent scope tracking as soft audit constraint | Hard blocking breaks legitimate flows (OAuth redirects); audit trail is sufficient for now |
| User-customizable domain blocklist (not hardcoded) | Users know their own sensitive sites; hardcoded lists are incomplete and inflexible |
| Only `script.execute` + `element.fill` blocked on user-blocked domains | Other actions (click/navigate/snapshot) are read-only or low-risk; blocking everything is too aggressive |
| Firefox native autofill allowed without restriction | Browser fills password fields without exposing plaintext to JS; safe by design |
| Domain blocklist over allowlist | AI agents need to work on arbitrary pages; allowlist too restrictive |
| No user confirmation popups | Breaks AI automation flow; clear error codes + extension settings page are sufficient |
| No script hash whitelist | AI scripts are dynamically generated; impossible to pre-compute hashes |
| No WeakRef for DOM cache | Content script lifecycle already handles cleanup on navigation; per-snapshot clear is sufficient |
| `script.execute` off by default | Defense-in-depth; explicit opt-in for most dangerous capability |
| Per-snapshot nodeId cleanup over WeakRef | Simpler, more predictable, sufficient for preventing leaks in MVP |
