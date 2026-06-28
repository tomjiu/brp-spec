# Changelog

All notable changes to the BRP (Browser Runtime Protocol) project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] — 2026-06-28

### v0.4.0-alpha: TypeScript Migration + Rust Modularization

This release is a pure structural refactor — zero new features, zero behavior changes.

#### Extension: JavaScript → TypeScript

- **Background scripts**: `extension/background/background.js` + `handlers.js` → `extension/src/background.ts`, `handlers.ts`, `types.ts`. Strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`.
- **Content scripts**: `extension/content/content.js` + `itree.js` → `extension/src/content.ts`, `itree.ts`, `types.content.ts`. Zero `as HTMLElement` casts — all element access uses `instanceof` type guards.
- **Build pipeline**: esbuild bundles 4 entry points (`dist/background.js`, `dist/handlers.js`, `dist/content.js`, `dist/itree.js`). Build artifacts gitignored — must run `npm run build` before loading extension.
- **Tests**: 75 unit tests (Vitest), updated to import TypeScript sources directly.

#### Bridge: Modularization

- **config.rs**: `BridgeConfig` — environment variable loading, token generation, file persistence.
- **ws_server.rs**: WebSocket server, extension registration, message dispatch.
- **router.rs**: Request routing, owns `BridgeState` exclusively. All other modules communicate via channels.
- **native_msg.rs**: Stdin/stdout I/O loops.
- **main.rs**: Thin orchestrator — reduced from 864 to 115 lines.

#### ts-rs Integration

- Six protocol types derive `#[derive(TS)]`: `SessionState`, `ClientInfo`, `Capabilities`, `InitializeParams`, `InitializeResult`, `ServerInfo`.
- All wire types use `#[serde(rename_all = "camelCase")]` + `#[ts(rename_all = "camelCase")]` for consistent cross-language field naming.
- Bindings generated to `bridge/bindings/*.ts`.

#### Fixes

- **JsonRpcRequest**: Tightened to JSON-RPC 2.0 spec — removed errant `error` field, made `jsonrpc`/`id`/`method` required.
- **Version sync**: Cargo.toml, package.json, manifest.json all bumped to `0.3.3`.

## [0.3.2] — 2026-06-27

### B1 RFC Complete (§6-8) + Spike Improvements

- **B1 IPC spike**: `spikes/b1-ipc-spike/` — Rust prototype demonstrating Unix Socket + Named Pipe IPC, PID lockfile with stale cleanup, and Windows Named Pipe ACL (DACL).
- **Bridge cleanup**: Removed stale spike artifacts, added Windows PID support.
- **RFC B1**: Sections 6-8 of the B1 Native Messaging Auto-Link RFC completed in `docs/rfcs/`.

## [0.3.1] — 2026-06-27

### Quality Foundation

- **CI pipeline**: Rust (fmt + clippy + test + audit + deny) via GitHub Actions.
- **RFC sections**: B1 RFC §§4-5 completed.
- **Extension test suite**: Expanded to 73 unit tests covering pure logic module and async patterns.
- **CI workflow structure**: `ci.yml` with `ci-pass` summary gate for required checks.

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
