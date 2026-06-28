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
  and the socket is closed (`bridge/src/main.rs`, `run_ws_server`).
- **Token file with restricted permissions.** The Bridge generates a UUID v4
  token at startup and writes it atomically with mode `0600` on Unix
  (`generate_auth_token` in `bridge/src/main.rs`).
- **Reconnection backoff (client side).** The extension applies jittered
  reconnect delays and a larger backoff on auth failure
  (`extension/background/background.js`). Note: this is a *client-side*
  politeness measure and is **not** a server-side rate limit.
- **Restricted-page guard.** Content scripts are not injected into `about:*`,
  `chrome:*`, `moz-extension:*`, etc.; such requests return
  `BRP_RESTRICTED_PAGE`.
- **Script execution isolation.** `script.execute` uses the `Function`
  constructor (not `eval`) and enforces a 1 MB source size limit
  (`extension/content/content.js`).
- **Notification sequence numbers.** All notifications forwarded to the AI
  client carry a monotonic sequence number for gap detection.
- **Native Messaging Auto-Link (v0.4.0 B1).** Planned: token provisioning via
  `browser.runtime.connectNative()` stdout, replacing file-based token delivery.
  See [`docs/v0.4.0-B1-IMPLEMENTATION-PLAN.md`](docs/v0.4.0-B1-IMPLEMENTATION-PLAN.md)
  for security considerations.

## 4. Known risks / hardening backlog

The following are **known gaps** being addressed by the roadmap in
[`docs/SECURITY-ARCHITECTURE-DECISIONS.md`](docs/SECURITY-ARCHITECTURE-DECISIONS.md):

- The WebSocket handshake does **not** yet validate the `Origin` header, so a
  malicious page can reach the server (it still needs the token, but the socket
  is reachable). — *P0*
- The auth-token HTTP endpoint serves with `Access-Control-Allow-Origin: *`,
  allowing cross-origin token theft. The plan removes this endpoint. — *P0*
- No **server-side** connection rate limiting; a local loop can exhaust CPU/FDs
  even when connections are ultimately rejected. — *P0*
- No JSON-RPC message size / nesting-depth / array-length limits at the
  transport and parse layers. — *P1*
- `element.getAttribute("value")` can read autofilled password fields; redaction
  currently exists only in the Interaction Tree, not on every read path. — *P1*
- URL-scheme validation only guards `page.navigate`; indirect navigation
  (clicking `file:`/`javascript:` links) is not globally intercepted. — *P1*
- `script.execute` is enabled by default. — *P2*
- Token comparison is not constant-time. — *P2* (becomes mandatory if a
  long-lived Standalone token is introduced).

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
