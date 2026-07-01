# BRP Development Roadmap

> Last updated: 2026-07-01

## Legend

- [x] Done
- [~] In progress
- [ ] Planned
- [?] Needs investigation

---

## v0.3.0 — Security Hardening (baseline) ✅

- [x] WebSocket Origin validation
- [x] Server-side rate limiting (sliding window + unauth cap)
- [x] JSON-RPC message size/depth/array/object limits
- [x] Constant-time token comparison
- [x] Navigation sentinel scoped to agent tabs
- [x] Sensitive field redaction (ITree + getAttribute)
- [x] script.execute gate (BRP_ALLOW_SCRIPT_EXECUTE=1)
- [x] Token auto-generation (UUID v4, mandatory)
- [x] Method whitelist (Bridge rejects unknown methods)
- [x] Dynamic forwarding timeout
- [x] Pending request cleanup on extension disconnect
- [x] E2E tests (12/12 passing)

## v0.3.1 — Quality Foundation ✅

- [x] **C2** GitHub Actions CI (ubuntu-latest): fmt/clippy/test/audit/deny
- [x] **C2** cargo-deny config (license whitelist, advisory DB, sources)
- [x] **D2** Rust unit tests: auth.rs (15 tests) + ratelimit.rs (7 tests) = 22 total
- [x] **C3** Modularization: auth.rs + ratelimit.rs extracted, main.rs 943→790 lines
- [x] **B1 RFC** Chapters 1-3: lifecycle model, IPC discovery, threat model
- [x] **B1 Spike** Dual-mode binary, tokio native IPC (Unix Socket + Windows Named Pipe)
- [x] PR #5 merged to main

## v0.3.1-patch — Extension Tests + RFC Expansion ✅

- [x] **D1** background.js: extract pure functions (message routing, state machine) from `browser` globals → `handlers.js`
- [x] **D1** itree.js / content.js: Vitest + happy-dom unit tests (73 tests)
- [x] **D1** Cover the async listener bug that leaked to v0.3.0 production (11 regression tests)
- [x] **B1 RFC** §4 Installation & Distribution (install.sh, --install, manifest paths)
- [x] **B1 RFC** §5 Token Bootstrap Protocol (IPC message format, token reusability)

## v0.3.2 — B1 RFC Finalization [x]

- [x] **B1 RFC** §6 Extension-Side Implementation (connectNative timing, supportsAutoLink)
- [x] **B1 RFC** §7 Crash Recovery & Reconnection (browserId, heartbeat, exponential backoff)
- [x] **B1 RFC** §8 Multi-Browser Support (Firefox + Zen manifest coexistence)
- [x] **B1 Spike** Stale socket/lockfile cleanup: automated test (bridge crash → bootstrap detects → cleans)
- [x] **B1 Spike** Windows PID liveness check (OpenProcess + GetExitCodeProcess)
- [x] **B1 Spike** Cross-platform validation (Linux + macOS + Windows)
- [x] install.sh / install.ps1 draft

## v0.4.0-alpha — TypeScript Migration (pure refactor, zero new features) [x]

- [x] **C1** background.js → TypeScript (src/background.ts, src/handlers.ts)
- [x] **C1** content.js → TypeScript (src/content.ts, src/itree.ts)
- [x] **C1** ts-rs: auto-generate TS types from Rust structs (6 types in bridge/bindings/)
- [x] **C1** esbuild for extension build pipeline
- [x] **C3** Complete modularization: ws_server.rs / native_msg.rs / router.rs / config.rs

## v0.4.0 — B1 Implementation + Stability [x]

> Detailed plan: [docs/v0.4.0-B1-IMPLEMENTATION-PLAN.md](v0.4.0-B1-IMPLEMENTATION-PLAN.md)

- [x] **PR #18** Bridge dual-mode (`--mode=bridge` / `--mode=bootstrap`) + `--echo` smoke flag
- [x] **PR #20** Unix Socket IPC (Linux/macOS lockfile coordination)
- [x] **PR #21** Windows Named Pipe with DACL (full SECURITY_ATTRIBUTES implementation)
- [x] **PR #22** PID lockfile + stale cleanup (no MRU reuse)
- [x] **PR #23** Extension connectNative + auto-link (token via stdout, WS auto-connect)
- [x] **PR #17** This implementation plan document itself

## v0.4.1 — DOM Interaction Reliability [x]

- [x] **E3** DOM Precondition validation (tagName, textContains, attributes)
- [x] **E4** Context Recovery Pipeline (selector fallback chain)
- [x] **PR #27** Bridge Mode Random Port Support
- [x] **PR #26** TS Migration Cleanup (JS → TS)

## v0.4.2 — Multi-Instance [~] Deferred

> Deferred to v1.0 candidate phase. Code still evolving (v0.5.0 changes core behavior).
> B1 auto-link not CI-testable (Firefox headless limitation). Manual testing for B1.

- [ ] MRU multi-instance reuse
- [ ] Real Extension Integration Tests (web-ext + headless Firefox)

## v0.4.x — Real Extension Integration Tests [~] Deferred

> Merged into v0.4.2 deferred. Will be added in v1.0 candidate phase.

- [ ] **D1** web-ext + headless Firefox: full flow (connect → navigate → ITree → click)
- [ ] Fixed test pages (local SPA), retry mechanism

## v0.5.0 — Defense in Depth [x]

- [x] **E1** Permission gating (confirm dialogs for navigation, form submit, script.execute)
- [x] **E2** Domain blacklist (user-configurable, wildcard support)
- [x] **E5** Screenshot permission gate, log sanitization, CSP hardening
- [x] **B2** Multi-token (per-client tokens, independent revocation)

## v0.5.1 — User Trust: Visibility + Control [x]

- [x] **Status Icon** Extension toolbar icon: 4 states (disconnected/idle/active/error) + badge
- [x] **Page Indicator** Content script floating status bar on each page
- [x] **Domain Allowlist** Skip E1 ask for trusted domains, allowlist takes priority over blacklist

## v0.5.2 — Tab-level Permissions + History Access [x]

- [x] **Tab Permission Check** `controllableTabs` Set + `BRP_TAB_NOT_CONTROLLABLE` error
- [x] **tab.setControllable** User/AI can toggle tab controllable state
- [x] **Auto-demote** Tab demotes to not-controllable on user E1 denial
- [x] **Indicator Click** Page indicator click toggles controllable
- [x] **Popup UI** Extension popup lists all tabs with controllable toggle
- [x] **History Access** Optional `history` permission + `history.search`/`history.delete` methods

## v0.6.0 — Tech Debt + tabGroups (Experimental) [x]

- [x] **ts-rs Type Alignment** Bridge struct → auto-generated TS type, extension uses generated
- [x] **tabGroups Coloring** (Experimental) Firefox v139+ tab group colors with page-indicator fallback
- [x] **Fallback Detection** `!browser.tabGroups` → silent fallback to page-indicator

## v0.7.0 — Test Infrastructure [x]

- [x] **Integration Framework** web-ext + headless Firefox test runner + CI
- [x] **E2E Action Tests** navigate/click/fill/screenshot end-to-end
- [x] **Contract Tests** Bridge ↔ Extension message format verification
- [x] **Error Yellow Fix** tabGroups catch block updateGroupColor(error)

## v0.8.0 — Stabilization + API Freeze [x]

- [x] **E2E CI (xvfb)** E2E tests in CI with xvfb, continue-on-error
- [x] **E2E CI Disabled** Firefox + extension unreliable in CI — run locally
- [x] **API.md** Protocol contract documentation + API freeze
- [x] **Docs Polish** README + USAGE + SECURITY completion
- [x] **Regression Tests** Backward compat: B1/multi-token/storage/protocol
- [x] **Flaky Fix** ws-smoke polling instead of fixed delay
- [x] **UI Bug Fixes** tabGroups 3 fixed groups (blue/green/yellow), scroll doc
- [x] **Bridge Auto-Connect** IPC lock + localhost token skip
- [x] **Release Workflow** bridge binaries + extension xpi

## v0.9.0 — Protocol Hardening [x]

- [x] **Capability Enforce** (#68) Negotiated capabilities enforced (-32005)
- [x] **Version Negotiation** (#69) Semver-based with same-major 1.x+ support
- [x] **Security Hardening** (#75) Loopback bypass removed, WS backoff, unwrap elimination
- [x] **Error Model** (#75) Category field in all error responses
- [x] **Bridge Discovery** (#75) Unified discovery via lockfile + register_client WS
- [~] **Session Recovery** (#70-71) Deferred to v1.0
- [~] **Permission Model v2** (#72) Deferred to v1.0
- [~] **Multi-Instance** (#73) Deferred to v1.0

## v1.0 — Stable API + Compat [ ]

- [ ] Session Recovery (sessionId reuse + 30s retention from #70-71)
- [ ] Permission Model v2 (resource-level access control from #72)
- [ ] Multi-Instance (instanceId routing from #73)
- [ ] supportsAutoLink capability negotiation + backward compatibility matrix
- [ ] Multi-browser compatibility test matrix (Firefox / Zen / LibreWolf)
