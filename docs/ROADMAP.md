# BRP Development Roadmap

> Last updated: 2026-06-28

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

## v0.4.1 — DOM Interaction Reliability [ ]

- [ ] **E3** DOM Precondition validation (tagName, textContains, attributes)
- [ ] **E4** Context Recovery Pipeline (selector fallback chain, acceptFallback opt-in)

## v0.4.2 — Multi-Instance [ ]

- [ ] MRU multi-instance reuse (currently each extension starts its own bridge)

## v0.4.x — Real Extension Integration Tests [ ]

- [ ] **D1** web-ext + headless Firefox: full flow (connect → navigate → ITree → click)
- [ ] Fixed test pages (local SPA), retry mechanism

## v1.0-pre — Stable API + Compat [ ]

- [ ] supportsAutoLink capability negotiation + backward compatibility matrix
- [ ] Multi-browser compatibility test matrix (Firefox / Zen / LibreWolf)

## v0.5.0+ — Defense in Depth [ ]

- [ ] **E1** Permission gating (confirm dialogs for navigation, form submit, script.execute)
- [ ] **E2** Domain blacklist (user-configurable, wildcard support)
- [ ] **E5** Screenshot permission gate, log sanitization, CSP hardening
- [ ] **B2** Multi-token (per-client tokens, independent revocation)
- [ ] **C4** Python adapter: merge into Bridge or keep separate (decide based on ecosystem)
