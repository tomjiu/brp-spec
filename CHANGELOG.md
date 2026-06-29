# Changelog

All notable changes to the BRP (Browser Runtime Protocol) project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-06-29

### E1: Permission Gating

AI actions on sensitive targets require user confirmation via a browser-native dialog (Allow / Deny / Always Allow this Session). Covers script execution, navigation to sensitive domains, and clicking sensitive buttons.

- 3-state gate per action: `always` (block), `ask` (prompt), `never` (allow)
- `sensitiveDomains`: wildcard domain patterns (e.g. `*.bank.com`)
- `sensitiveButtonPatterns`: keyword/attribute/CSS matching
- Configurable via Extension Options page
- `PermissionGateConfig` persisted in `browser.storage.local` with deep merge

### E2: Domain Blacklist + Click Hard-Block

Hard-wired domain blacklist prevents AI from navigating to or clicking links pointing to blacklisted domains. Extension intercepts `page.navigate` and `<a href>` clicks in content scripts.

- `domainBlacklist` field in `PermissionGateConfig` (default empty)
- `<a href>` click interception in content script — click event listener extracts domain, checks blacklist before dispatching
- Error code: `BRP_DOMAIN_BLACKLISTED`
- 201-line `blacklist-click.test.ts` covering 14 scenarios

### E5: Screenshot Blur + Log Sanitizer

Screenshot blur: temporary `filter: blur(8px)` CSS applied to sensitive form fields before `page.screenshot`, removed immediately after. Default off.

- 3-state gate: `always` / `ask` / `never`
- 5 built-in field types: password, credit card, CVV, email, SSN
- Custom CSS selectors for advanced use cases
- Configurable via Extension Options page

Log sanitizer: regex-based redaction of token/password/bearer patterns in bridge logs.

- `sanitized_log!` macro wrapping `log::info!`
- 4 patterns: `token=xxx`, `password=xxx`, `Authorization: Bearer xxx`, `"authToken": "xxx"`

### B2: Multi-token

Per-client tokens for MCP clients. Master token issues/revokes client tokens via JSON-RPC API.

- Master token from `BRP_MASTER_TOKEN` env or auto-generated (`mt_` prefix)
- Client tokens via `token.issue` JSON-RPC method (`ct_` prefix)
- `token.revoke` — independently revocable without affecting other clients
- `token.list` — list all active client tokens
- `tokens.json` persistence with 0600 permissions
- Adapter `--issue-token` / `--revoke-token` CLI flags
- Backward compatible: legacy `auth_token` still valid

### Test Summary

| Component | Tests |
|-----------|-------|
| Extension | 170 |
| Bridge | 56 |

### Breaking Changes

None. All new features are optional with backward-compatible defaults.

---

## [0.4.1] — 2026-06-28

### E3: DOM Precondition Validation

AI can now attach `precondition` to element actions (click/type/fill/hover/select). Extension validates the target element matches before executing, rejects with `BRP_PRECONDITION_FAILED` on mismatch.

- New `Precondition` type: `tagName` (case-insensitive), `textContains`, `attributes`
- New error code: `BRP_PRECONDITION_FAILED` with actual element info (tagName, textContent, attributes)
- New `extension/src/precondition.ts`: `validatePrecondition()` pure logic module
- 9 JS DOM unit tests
- Optional field, backward compatible

### E4: Context Recovery Pipeline

When a selector fails, automatically retry via fallback chain: `nodeId → role → css → xpath → coordinate → text`. AI opts in with `acceptFallback: true`.

- New `extension/src/selector-fallback.ts`: `findElementWithFallback()`
- Returns `matchedSelector: {type}` to tell AI which selector actually matched
- 7 JS DOM unit tests
- Optional field, backward compatible (default `false`)

### Bridge Mode Random Port

Bridge mode now supports `BRP_WS_ADDR=127.0.0.1:0` for OS-assigned random port. Multiple MCP clients can coexist without port conflict. Fixed port (`9817`) still default for backward compat. Adapter reads actual port from bridge's first stdout message.

### Tech Debt: TS Migration Cleanup

- `extension/tests/*.test.js` → `.ts` (554 lines)
- `extension/options/options.js` → `options.ts` (88 lines)
- GitHub JS percentage: ~9.6% → ~1.2%
- Pure refactor, zero behavior change

### CI Stability

- 3 flaky Windows pipe tests (DACL error 1336 on CI runner) marked `#[ignore]`, pass on real Windows

### Breaking Changes

None. All new features are optional fields with backward-compatible defaults.

## [0.4.0] — 2026-06-28

### B1: Native Messaging Auto-Link

This release introduces B1 — the biggest UX improvement since v0.3.0. Users no longer need to manually copy/paste auth tokens.

New flow: Load extension → bridge auto-starts → WebSocket auto-connects. No token file, no Options page configuration.

### Bridge (Rust)

- Dual-mode binary (`--mode=bridge` / `--mode=bootstrap`)
- Unix Socket IPC (Linux/macOS): single-instance enforcement
- Windows Named Pipe + DACL: restricted to current user SID
- PID lockfile + stale cleanup: atomic write, cross-platform PID liveness
- Real WS port: bootstrap binds port 0, reads OS-assigned port
- Two-phase wait: bridge waits for WS connection (30s timeout) before stdin EOF

### Extension (TypeScript)

- `native.ts` module: `startBridge()` — connectNative → read token → connect WebSocket
- 3-second token timeout: shows "Bridge not installed" if no token received
- Token storage: bootstrap token stored to `browser.storage.local`
- Native port lifecycle: port kept open during WS session, disconnected on WS close
- Fallback: if B1 fails, falls back to v0.3.x manual config

### Security

- DACL on Windows: Named Pipe restricted to current user SID (cross-user verified)
- Token never written to file in B1 mode: delivered via stdout only
- 30s WS connection timeout: prevents zombie bridge processes

### Multi-Instance Support

B1 architecture natively supports multiple browser instances:

| Scenario | Support | Mechanism |
|---|---|---|
| Multiple tabs | ✅ | Shared background, single WS |
| Multiple windows (same profile) | ✅ | Shared background |
| Multiple browsers (Firefox + Zen) | ✅ | Each spawns own bridge with random port |
| Multiple profiles | ✅ | Each spawns own bridge |
| Multiple MCP clients | ⚠️ | Manual `BRP_WS_ADDR` config needed |

See [docs/USAGE-MODES.md](docs/USAGE-MODES.md) for details.

### Prototype Validation (PR #17)

B1 implementation validated by 5 prototype tests, all passed.

### Breaking Changes

None. v0.3.x manual config path preserved as fallback.

## [0.3.4] — 2026-06-28

### Install Scripts

- **install.sh**: Linux/macOS native messaging host installer — copies manifest, replaces placeholder with real binary path, browser auto-detection, `--uninstall` flag.
- **install.ps1**: Windows native messaging registry installer (`HKCU\Software\Mozilla\NativeMessagingHosts\org.brp.bridge`), UTF-8 no-BOM manifest, persistent `%LOCALAPPDATA%` path.

### CI

- **Triple-OS matrix**: Rust CI runs `cargo fmt --check` + `cargo clippy` + `cargo test` on ubuntu-latest, macos-latest, and windows-latest. `cargo audit` and `cargo deny` remain ubuntu-only.

This release marks the completion of the v0.3.x series. Next: v0.4.0 B1 implementation (Native Messaging Auto-Link).

## [0.3.3] — 2026-06-28

### v0.4.0-alpha: TypeScript Migration + Rust Modularization

Pure structural refactor — zero new features, zero behavior changes.

#### Extension: JavaScript → TypeScript

- Background scripts and content scripts migrated to strict TypeScript with esbuild build pipeline.
- Zero `as HTMLElement` casts — all element access uses `instanceof` type guards.
- Two tsconfigs: background (`ES2022` lib) and content (`ES2022` + `DOM` lib).
- Tests: 75 unit tests (Vitest).

#### Bridge: Modularization

- **config.rs**: `BridgeConfig` — environment variable loading, token generation, file persistence.
- **ws_server.rs**: WebSocket server, extension registration, message dispatch.
- **router.rs**: Request routing, owns `BridgeState` exclusively. All other modules via channels.
- **native_msg.rs**: Stdin/stdout I/O loops.
- **main.rs**: Thin orchestrator — reduced from 864 to 115 lines.

#### ts-rs Integration

- Six protocol types derive `#[derive(TS)]` with consistent `rename_all = "camelCase"`.
- Bindings generated to `bridge/bindings/*.ts`.

#### Fixes

- `JsonRpcRequest` tightened to JSON-RPC 2.0 spec.
- All wire types use `serde(rename_all = "camelCase")` + `ts(rename_all = "camelCase")`.
- Version sync: Cargo.toml, package.json, manifest.json unified.

## [0.3.2] — 2026-06-27

### B1 RFC §6-8 + Spike Improvements

- B1 IPC spike (`spikes/b1-ipc-spike/`): Unix Socket + Named Pipe IPC, PID lockfile with stale cleanup, Windows PID liveness check (OpenProcess + GetExitCodeProcess). Windows Named Pipe ACL (DACL) deferred to v0.4.0 production — see spike README.
- RFC B1 sections 6-8 completed in `docs/rfcs/`.
- Bridge cleanup: removed stale spike artifacts, added Windows PID support.

## [0.3.1] — 2026-06-27

### Quality Foundation

- CI pipeline: Rust (fmt + clippy + test + audit + deny) via GitHub Actions.
- B1 RFC §§4-5 completed.
- Extension test suite expanded.
- CI workflow with `ci-pass` summary gate.

## [0.3.0] — 2026-06-27

### Security Hardening

This release is a comprehensive security hardening of the BRP Bridge and Extension, addressing threats identified in the [security architecture review](docs/SECURITY-ARCHITECTURE-DECISIONS.md).

#### Authentication & Authorization

- **Mandatory token authentication**: The Bridge now always generates a UUID v4 token at startup and requires it for all WebSocket registrations. Token is written to a platform-specific file (`%APPDATA%\brp-bridge\token` on Windows, `~/.brp-bridge-token` on Linux/macOS) with 0600 permissions. Override with `BRP_AUTH_TOKEN` env var.
- **Removed HTTP token server**: Eliminated the local HTTP endpoint that served tokens (CORS wildcard vulnerability). Token delivery now happens exclusively through the Native Messaging stdout channel and file system.
- **Constant-time token comparison**: Uses `subtle::ConstantTimeEq` to prevent timing attacks on token validation.
- **Extension Options page**: New options UI (`extension/options/`) for configuring the auth token via `browser.storage.local`.

#### Connection & Transport Security

- **WebSocket Origin validation**: `accept_hdr_async` with custom `OriginValidator` rejects connections from non-extension origins (blocks CSWSH and DNS rebinding). Allowed origins: `null` (NM extensions), `moz-extension://`, `chrome-extension://`, and absent (raw clients — token catches them).
- **Server-side rate limiting**: `RateLimiter` enforces max 10 connections/second and 5 concurrent unauthenticated connections, applied pre-WebSocket upgrade.
- **JSON-RPC message limits**: 4MB max message size, 32 max nesting depth, 1024 max array length, 256 max object keys.
- **Pending request cleanup**: On extension disconnect, all pending requests for that browser are immediately failed with `BRP_EXTENSION_DISCONNECTED`.
- **Dynamic forwarding timeout**: `max(30s, client_timeout + 10s)` — fixes the conflict between 30s Bridge timeout and 60s `waitForSelector` cap.

#### Navigation & Input Safety

- **Navigation sentinel (scoped)**: `webNavigation.onBeforeNavigate` blocks non-http(s) schemes (`file:`, `javascript:`, `data:`, `blob:`, etc.) — scoped to agent-controlled tabs only (`agentTabIds` set). User's own browsing is unaffected.
- **Method whitelist**: Bridge rejects unknown methods before forwarding to extension.
- **URL scheme validation**: `page.navigate` and `tab.open` reject non-http(s)/about:blank URLs at the Bridge level (defense in depth — extension also validates).
- **Input validation**: Selectors, text, URLs, tab IDs, key combinations, and values arrays are validated for type, length, and range in both Bridge and extension.

#### Data Protection

- **Sensitive field redaction**: Password, hidden, and credit card fields are redacted (`[REDACTED]`) in both the Interaction Tree and `getAttribute` responses. Redaction also triggers on sensitive keywords (cvv, ssn, otp, pin, creditcard, etc.) found in field `name`, `id`, or `placeholder` attributes.
- **script.execute gate**: Disabled by default. Requires `BRP_ALLOW_SCRIPT_EXECUTE=1` to enable. Uses `new Function()` (not `eval()`) with 1MB code and 1MB result size limits.

### Added

- **RFC specification documents** under `docs/rfcs/`: RFC0000 (Process), RFC0001 (Core Protocol), RFC0001 Optimization, RFC0002 (Core Actions), plus CONTRIBUTING.md and RFC_TEMPLATE.md.
- **MCP adapter** (`adapter/brp_mcp_adapter.py`): FastMCP stdio server that spawns Bridge as a subprocess via Native Messaging, exposing 21 BRP tools to MCP-compatible AI clients.
- **Standalone mode**: `BRP_STANDALONE=1` runs Bridge as a pure WebSocket server without stdin/stdout.
- **Multi-browser support**: Multiple browsers (Firefox, Zen) can connect simultaneously; requests target specific browsers via `browserId` parameter.
- **RFC0002 core actions**: `element.hover`, `element.select`, `element.getAttribute`, `keyboard.press`, `page.waitForSelector`, `page.goBack`, `page.goForward`, `page.reload`.
- **E2E test suite**: Full integration test with simulated Extension over WebSocket (12 test cases).

### Fixed

- **content.js async listener**: Removed `sendResponse`/`return true` pattern incompatible with `async` functions in Firefox. Actions now correctly return data via Promise resolution.
- **ITree builder**: Fixed recursion into non-interactive elements — tree now includes all meaningful descendants regardless of parent interactivity.
- **agentTabIds memory leak**: Added `tabs.onRemoved` listener to clean up closed tab IDs.

### Changed

- **Minimum Rust version**: Declared `rust-version = "1.85"` in `Cargo.toml` (required by `uuid` → `getrandom` 0.4.x).
- **Removed unused `rand` dependency** from Bridge.
- Bridge version, Extension version, and Adapter version all bumped to **0.3.0**.

### Known Limitations

- Token provisioning is manual: the Bridge auto-generates a token and writes it to a file, but the user must copy it into the Extension Options page. No automatic token injection to the Extension.
- E2E tests use a Python WebSocket simulator and do not exercise real Firefox content scripts. Manual regression testing with a real extension is recommended before production use.

## [0.2.0] — 2026-06-26

### Added

- Multi-browser support with `browserId` routing.
- MCP adapter (`brp_mcp_adapter.py`) for AI client integration.
- Bridge standalone mode (`BRP_STANDALONE`).
- RFC0002 core actions (hover, select, getAttribute, keyboard.press, waitForSelector, goBack, goForward, reload).
- Security model documentation and hardening architecture decisions.
- E2E test suite.

### Fixed

- ITree builder now recurses into non-interactive parent elements.

## [0.1.0] — 2026-06-26

### Added

- **BRP Bridge** (Rust): stdin/stdout Native Messaging, JSON-RPC 2.0 protocol, WebSocket server for Extension.
- **Firefox Extension** (Manifest V2): WebSocket client, Interaction Tree builder, core actions (click, type, fill, scroll), MutationObserver for DOM changes.
- Session lifecycle (initialize/shutdown/exit) with sequence-numbered notifications.
- Basic smoke test script.
