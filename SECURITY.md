# BRP Security

This document describes the security model of the Browser Runtime Protocol (BRP):
the threat model it defends against, the protections currently implemented, the
risks that are explicitly **out of scope**, and the invariants that all future
changes must preserve.

> Status: Living document. The hardening roadmap that this model drives is tracked
> in [`docs/SECURITY-ARCHITECTURE-DECISIONS.md`](docs/SECURITY-ARCHITECTURE-DECISIONS.md).

## 1. What BRP exposes

BRP lets an AI agent drive the user's **real** browser session — including its
cookies, logins, and open tabs. The trust chain is:

```
AI Client (MCP) ──stdio/JSON-RPC──> Rust Bridge ──ws://127.0.0.1:9817──> Firefox Extension ──> User's browser
```

Two facts make this security-sensitive:

1. The Bridge runs a **local WebSocket server** on a loopback port. Loopback is
   **not** a trust boundary: any web page the user visits can attempt
   `new WebSocket("ws://127.0.0.1:9817")`, and any local process can open the
   same socket.
2. The extension can act on the user's authenticated sessions. A request that
   reaches a content script runs with the user's privileges on that origin.

## 2. Threat model

| Attacker | Origin validation | Token / Challenge | Notes |
|----------|:-----------------:|:-----------------:|-------|
| Malicious web page JS (`new WebSocket`, CSWSH) | **primary defense** | secondary | Browser always sends an `Origin` header; reject non-extension origins. |
| DNS rebinding | **primary defense** | secondary | Mitigated by Origin (and removing any HTTP credential endpoint). |
| Local non-browser process impersonating the extension | ✘ ineffective | **primary defense** | A raw client can omit/spoof `Origin`; only the credential stops it. |
| Local malicious user with filesystem access | ✘ | ✘ (partial) | Token file is `0600`; does not stop a user who can read their own home dir or run as root. |
| Compromised / malicious extension | ✘ | ✘ | Equivalent to a trusted-boundary breach. |

The two key controls are **orthogonal** and serve different purposes:

```
Origin validation   → authenticates the *source* (browser vs. anything else)
Challenge / token   → authenticates the *identity* (the real BRP extension)
```

Neither can be removed in favor of the other.

## 3. Currently implemented protections

These exist in the codebase today.

- **WebSocket credential check on registration.** The extension's first frame
  must be a `register` message carrying a valid token; mismatches are rejected
  and the socket is closed (`bridge/src/ws_server.rs`, `register_extension`).
- **Token file with restricted permissions.** The Bridge generates a UUID v4
  token at startup and writes it atomically with mode `0600` on Unix
  (`bridge/src/config.rs`, `BridgeConfig::load`).
- **Reconnection backoff (client side).** The extension applies jittered
  reconnect delays and a larger backoff on auth failure
  (`extension/src/background.ts`). Note: this is a *client-side*
  politeness measure and is **not** a server-side rate limit.
- **Restricted-page guard.** Content scripts are not injected into `about:*`,
  `chrome:*`, `moz-extension:*`, etc.; such requests return
  `BRP_RESTRICTED_PAGE`.
- **Script execution isolation.** `script.execute` uses the `Function`
  constructor (not `eval`) and enforces a 1 MB source size limit
  (`extension/src/content.ts`).
- **Notification sequence numbers.** All notifications forwarded to the AI
  client carry a monotonic sequence number for gap detection.
- **WebSocket Origin validation.** `accept_hdr_async` with custom
  `OriginValidator` rejects connections from non-extension origins
  (`bridge/src/ws_server.rs`).
- **Server-side rate limiting.** `RateLimiter` enforces 10 connections/sec and
  5 concurrent unauthenticated connections (`bridge/src/ratelimit.rs`).
- **JSON-RPC message limits.** 4 MB max size, 32 max nesting depth, 1024 max
  array length (`bridge/src/auth.rs`).
- **Sensitive field redaction.** Password, hidden, and credit card fields
  redacted in both Interaction Tree and `getAttribute` responses
  (`extension/src/itree.ts`, `extension/src/content.ts`).
- **Navigation sentinel.** `webNavigation.onBeforeNavigate` blocks non-http(s)
  schemes on agent-controlled tabs (`extension/src/background.ts`).
- **Constant-time token comparison.** Uses `subtle::ConstantTimeEq`
  (`bridge/src/auth.rs`).
- **script.execute gate.** Disabled by default; requires
  `BRP_ALLOW_SCRIPT_EXECUTE=1` (`bridge/src/config.rs`).

## 4. Known risks / hardening backlog

The following items were addressed in v0.3.0 (see [CHANGELOG](CHANGELOG.md)).
They remain documented here as a snapshot of the pre-v0.3.0 threat assessment.

- ✅ **WebSocket Origin validation** — implemented in v0.3.0 (`bridge/src/ws_server.rs`).
- ✅ **HTTP token endpoint removed** — eliminated in v0.3.0; token delivery via Native Messaging stdout only.
- ✅ **Server-side connection rate limiting** — implemented in v0.3.0 (`bridge/src/ratelimit.rs`).
- ✅ **JSON-RPC message size/depth limits** — implemented in v0.3.0 (`bridge/src/auth.rs`).
- ✅ **Sensitive field redaction on all read paths** — implemented in v0.3.0 (ITree + `getAttribute`).
- ✅ **URL-scheme sentinel (global onBeforeNavigate)** — implemented in v0.3.0 (`extension/src/background.ts`).
- ✅ **script.execute disabled by default** — implemented in v0.3.0 (`bridge/src/config.rs`).
- ✅ **Constant-time token comparison** — implemented in v0.3.0 (`bridge/src/auth.rs`).

No unresolved P0/P1 security gaps remain as of v0.3.3.

## 5. Out of scope (accepted residual risks for v0.3.0)

These are explicitly **not** defended against in the current design. They are
documented so reviewers do not mistake them for oversights:

- **Compromised extension.** Once the extension itself is malicious or
  hijacked, it is inside the trust boundary. Mitigated only probabilistically by
  AMO signing and a strict extension CSP.
- **Malicious local user / process with filesystem access.** The `0600` token
  file raises the bar but does not stop a process running as the same user (or
  root) from reading it.

## 6. Security invariants

Every change to BRP must preserve these invariants. They are the non-negotiable
rules the roadmap is built on:

1. **Origin validation and authentication are independent controls** — neither
   may be removed in favor of the other.
2. **No credential is ever distributed over HTTP / the network.** Credentials
   move in-band (Native Messaging stdio) or via user-entered configuration only.
3. **Sensitive data must be redacted on _every_ read path** (Interaction Tree,
   `getAttribute`, screenshots, logs), not just one.
4. **Security boundaries fail closed; heuristic policies fail open.**
   - Fail closed (hard block): credential reads, non-`http(s)` schemes,
     unauthenticated connections.
   - Fail open (audit + log): scope / "stray domain" heuristics, which must not
     hard-block legitimate flows such as OAuth redirects.
5. **Long-lived credentials require both rate limiting and constant-time
   comparison.** One-time, short-lived challenges may relax the constant-time
   requirement, but a single shared implementation (`subtle::ConstantTimeEq`) is
   preferred.
