# BRP Security Architecture Decisions (v0.3.0)

This document is the **frozen** architecture decision record for the v0.3.0
security hardening effort. It consolidates several independent reviews and
resolves their disagreements into a single ordered plan.

It is intentionally implementation-light: it records *what* to do and *why*, and
how the work is sliced into PRs. Detailed implementation lives in each PR.

Companion document: [`../SECURITY.md`](../SECURITY.md) (threat model + invariants).

> **Architecture is frozen.** Do not change a P0/P1 decision inside an
> implementation PR — amend this document first so reviews stay coherent and
> PR #N does not silently reverse PR #N-1.

## Context: current state

The current implementation already has:

- WebSocket token authentication on `register` (UUID v4, written to a `0600`
  file).
- Multi-browser support (connection pool keyed by `browserId`, registration
  protocol, `browserId` routing).
- RFC0002 core actions (hover / select / getAttribute / keyboard.press /
  navigation history / reload / waitForSelector).
- Restricted-page detection (`about:*`, `chrome:*`, `moz-extension:*` →
  `BRP_RESTRICTED_PAGE`).
- Client-side reconnect with jitter and auth-failure backoff.
- Content-script hardening (`Function` constructor instead of `eval`, 1 MB
  source limit).

What it lacks is summarized in [`SECURITY.md` §4](../SECURITY.md#4-known-risks--hardening-backlog).

## Key decision: abandon the "challenge file", do not patch it

The original plan proposed replacing the HTTP token server with a **challenge
file** on disk. This is rejected as a design, not merely tweaked:

1. **A WebExtension sandbox cannot read local files.** `fetch("file://…")` is
   blocked, so in Standalone mode the extension cannot read a challenge file at
   all — the connection would simply fail.
2. **Native Messaging already has an in-band channel.** In NM mode the browser
   spawns the Bridge and talks to it over stdin/stdout, so the challenge can be
   exchanged **directly during the handshake** — writing it to disk is both
   unnecessary and a larger attack surface.

**Decision:**

- **Native Messaging mode (default):** exchange a one-time, short-lived
  challenge **in-band over stdio** during the handshake. No file.
- **Standalone mode (`BRP_STANDALONE=1`):** the user configures a persistent
  token in the extension's Options page (stored in `browser.storage.local`).
- **Remove the HTTP token server entirely** (and its `Access-Control-Allow-Origin: *`).

## Decision: Origin validation and authentication are orthogonal

A recurring review error was treating Origin validation and the token as
interchangeable. They are not (see the threat-model table in
[`SECURITY.md` §2](../SECURITY.md#2-threat-model)):

- **Origin** defends against browser-originated attacks (a malicious page doing
  `new WebSocket`, DNS rebinding). The browser always attaches an `Origin`
  header; the server must reject anything that is not the extension origin
  (`Origin: null` for NM-launched extensions, or `moz-extension://<id>`).
- **Challenge / token** defends against non-browser local processes, which can
  omit or spoof `Origin`.

Both are mandatory. Removing either is an invariant violation.

`Host` header checks are **downgraded** to an optional sanity check only (guards
against misrouting/proxy mistakes); a `Host: 127.0.0.1` line is trivially
forgeable and is not a security control.

## Decision: connection rate limiting is P0, server-side

The only backoff today is **client-side** (in the extension), which a malicious
`while(true) new WebSocket()` loop simply ignores. Therefore:

- Rate limiting must run **after TCP `accept` but before the WebSocket upgrade
  (`accept_async`)**, so the server does not pay tungstenite handshake cost per
  abusive connection.
- Limit **both** connections/second **and** the number of concurrent
  *unauthenticated* connections, plus a cap on the `extensions` / `pending`
  maps, to also resist slow-loris-style "connect and never register" attacks.
- Treat `127.0.0.1` as an untrusted source.

## Decision: long-lived Standalone tokens need lifecycle controls

If a persistent token is introduced for Standalone mode, a leak (e.g. from
`browser.storage.local`) is exploitable for a long time. Required for MVP:

- **Regenerate ("rotate") token** button.
- **Display "last used" timestamp** to surface anomalies.

Deferred to **P3** (avoid scope creep — this is effectively an API-key system):

- Multiple named tokens (per-client: Claude / Codex / CI), each with independent
  last-used and revocation.

Because a long-lived token widens the brute-force/timing window, introducing it
**promotes constant-time comparison and rate limiting from "nice to have" to
mandatory**.

## Decision: constant-time comparison, single implementation

Use `subtle::ConstantTimeEq` (cost ≈ 0) for all credential comparison. Do **not**
fork the comparison code per mode; a single constant-time implementation covers
both the NM challenge and the Standalone token and reduces maintenance surface.

---

## Prioritized roadmap

### P0 — must ship together

These are interdependent; shipping a subset leaves an exploitable gap.

- WebSocket `Origin` validation (mandatory; reject non-extension origins by TCP
  close, no JSON-RPC error, to avoid information leak).
- Native Messaging handshake uses **in-band stdio challenge**.
- Standalone mode uses a **persistent, user-configured token**.
- **Server-side connection rate limiting** (pre-upgrade) + concurrent
  unauthenticated-connection cap.
- **Remove the HTTP token server** (and its CORS wildcard).
- JSON-RPC **size / depth / array-length limits** at the transport and parse
  layers.

### P1

- **Global navigation sentinel** via `webNavigation.onBeforeNavigate`: hard-block
  any non-`http(s)`/`about:blank` navigation (covers clicked `file:`/`javascript:`
  links, `window.location`, iframes — not just `page.navigate`).
- **Dynamic forwarding timeout** — fixes the bug below.
- Business-layer input validation (URL scheme, `tabId`/`pageIdx` ranges,
  selector length, `element.select` array size, `keyboard.press` key length).
- **`getAttribute` redaction** for password / sensitive fields, done together
  with Interaction Tree redaction so *every* read path is closed.

### P2

- Firefox internal-API permission gates (bookmarks / history / passwords /
  cookies / downloads) — blocked by default, opt-in via Options page.
- User-customizable domain blocklist (gates `script.execute` and `element.fill`
  only; read-only actions remain allowed).
- DOM **precondition checks** on `element.click` / `element.fill` (verify
  tagName / text before acting) **plus** a sliding-window `nodeId` cache
  ("find it" + "hit the right one").
- `script.execute` **off by default** (env opt-in) + result size cap.
- **Constant-time** credential comparison (`subtle`).
- **Log sanitization tiers** (never log URLs with query params, user input,
  tokens, challenges, screenshot data; redact by `RUST_LOG` level).
- Screenshot permission gate + per-screenshot size cap.

### P3

- CI: `cargo fmt` / `cargo clippy` / unit tests / `cargo audit`, plus the
  WebExtension E2E suite.
- Extension Content Security Policy hardening (`script-src 'self'; object-src 'none'`).
- Bridge code modularization (`transport/websocket.rs`, `protocol/challenge.rs`,
  `router.rs`, `config.rs`, `tests.rs`).
- Multiple named Standalone tokens.

## Concrete bug captured during review

**The Bridge forwarding timeout (30 s, hard-coded) conflicts with the planned
`waitForSelector` cap (60 s).** A 45 s `waitForSelector` would hit the Bridge's
30 s timeout first and return `BRP_TIMEOUT` while the extension keeps waiting,
desynchronizing the two sides. The forwarding timeout must be computed
**dynamically** per method (e.g. `max(client_timeout + buffer, default_min)`).
Tracked under P1 ("Dynamic forwarding timeout").

**Pending-request leak on disconnect.** When an extension disconnects, only its
entry in the connection pool is removed; its in-flight `pending` requests are not
failed until the 30 s timeout elapses. On disconnect, the Bridge should
immediately fail that browser's pending requests with `BRP_EXTENSION_DISCONNECTED`.
Tracked under P1.

## PR slicing

Split to minimize cross-PR architectural churn:

| PR | Scope |
|----|-------|
| **PR1** | Handshake (stdio challenge + Standalone token) + WebSocket Origin validation + server-side rate limiting + remove HTTP token server + JSON-RPC size/depth limits. |
| **PR2** | Input validation + global navigation sentinel + dynamic forwarding timeout + pending-request cleanup. |
| **PR3** | Privacy (`getAttribute` + ITree redaction) + permission gates + domain blocklist + DOM precondition / sliding-window cache. |
| **PR4** | CI + `cargo audit` + extension CSP + `SECURITY.md` finalization. |

## Estimate

The original "4–5 hours for Phases 1–5" is unrealistic for work spanning Rust,
the extension, an Options page, and two test suites. Plan for roughly 2–3
focused sessions, sliced as above.

## Security invariants

See [`SECURITY.md` §6](../SECURITY.md#6-security-invariants). Summary:

1. Origin validation and authentication are independent controls.
2. No credential distribution over HTTP / the network.
3. Sensitive data must be redacted on every read path.
4. Security boundaries fail closed; heuristic policies fail open.
5. Long-lived credentials require rate limiting and constant-time comparison.
