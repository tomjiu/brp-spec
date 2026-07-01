# Implementation Gap Analysis

> Last updated: 2026-07-01
> Protocol version: 0.9.0

## RFC Sections vs Implementation

| RFC Section | Status | Implementation Path | Test Coverage | Notes |
|---|---|---|---|---|
| §2.1 — Protocol Version | ✅ Complete | `session.rs`: `negotiate_version()` | 9 tests | PR #69 merged |
| §2.1.1 — Capability Negotiation | ✅ Complete | `session.rs`: `negotiated_capabilities`, `router.rs`: capability check (-32005) | 6 tests | PR #68 merged |
| §2.1.2 — Version Negotiation | ✅ Complete | `initialize()` negotiates semver | 9 tests | PR #69 merged |
| §2.1.3 — Session Recovery | ⚠️ Partial | `InitializeParams.session_id`, `InitializeResult.last_sequence` | 5 tests | PR #70 merged; full recovery (30s retention) deferred to v1.0 |
| §3 — Message Format | ✅ Complete | JSON-RPC 2.0 in `protocol/message.rs` | Unit + integration | v0.8.0 stable |
| §4 — Lifecycle (initialize/shutdown/exit) | ✅ Complete | `router.rs`: local handler | E2E tests | Bootstrap mode supported |
| §5 — Browser Methods (tab, page, element) | ✅ Complete | Forwarded to extension via WS | 274 extension tests | v0.8.0 stable |
| §6 — Token Management | ✅ Complete | `router.rs`: token.issue/revoke/list | 10 token tests | B2 API stable |
| §7 — Permission Model | ⚠️ Partial | Bridge-side enforcement (-32007), extension adapter layer | Bridge + Extension tests | PR #72 review approved. Full dialog UI deferred to v1.0 |
| §8 — Security (Authentication) | ⚠️ Partial | Token validation mandatory; loopback bypass removed | Manual testing | Phase 2 hardening complete |
| §8.1 — Origin Validation | ✅ Complete | `auth.rs`: `is_valid_origin()` | Unit tests | moz-extension:// + null allowed |
| §8.2 — Rate Limiting | ✅ Complete | `ws_server.rs`: `RateLimiter` | Unit tests | 10 conn/min, burst 2 |
| §9 — Multi-Instance | 🚧 Reserved | `instance_id` routing proposed | PR #73 review approved | Deferred to v1.0 |
| §10 — Error Model | ⚠️ Partial | `error_category()` mapping added in v0.9.0 | Minimal | Full structured errors with category in every response deferred |
| §11 — Notifications | ✅ Complete | `notification/*` forwarding | E2E tests | Browser events → AI client |
| §12 — Transport (Native Messaging) | ✅ Complete | `transport.rs`, `native_msg.rs` | Integration tests | stdin/stdout NM format |
| §13 — Transport (WebSocket) | ✅ Complete | `ws_server.rs` | Integration tests | Localhost-only WS |
| §14 — Bootstrap (B1 Auto-Link) | ✅ Complete | `main.rs`: `run_bootstrap()` | Manual testing | FireFox connectNative integration |
| §15 — Discovery / Pairing | 🚧 Reserved | Not implemented | None | Deferred to v1.0 |
| §16 — Event Replay | 🚧 Reserved | Not implemented | None | Deferred to v1.0 |
| §17 — Plugin System | 🚧 Reserved | Not implemented | None | Deferred to v1.0 |

## Legend

| Symbol | Meaning |
|---|---|
| ✅ Complete | Fully implemented and tested |
| ⚠️ Partial | Core functionality implemented; edge cases or UI deferred |
| 🚧 Reserved | API contract defined; implementation deferred to future release |

## v1.0 Priority

1. **Session Recovery (full)**: 30-second retention, `notification/sessionResumed`
2. **Permission Model (full)**: Custom dialog UI, MCP-level integration
3. **Multi-Instance**: `instanceId` routing with backward-compatible fallback
4. **Error Model (full)**: `category` in every error response
5. **Discovery / Pairing**: Standard discovery endpoint, OAuth-style pairing flow
6. **Event Replay**: `lastSequence`-based event gap recovery
