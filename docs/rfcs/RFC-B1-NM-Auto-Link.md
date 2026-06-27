# RFC-B1: Native Messaging Auto-Link

- **RFC Number:** B1
- **Title:** Native Messaging Auto-Link
- **Status:** Draft
- **Author:** tomjiu
- **Version:** 0.3.1
- **Created:** 2026-06-27
- **Requires:** RFC0001

---

## Abstract

This RFC specifies the Native Messaging (NM) auto-link mechanism that eliminates
manual token provisioning from the BRP setup flow. Instead of requiring users to
copy a token from a file and paste it into the extension Options page, the
Firefox extension spawns a lightweight bootstrap process via
`browser.runtime.connectNative()`, which discovers the running Bridge main
process over IPC, retrieves the session token, and returns it through the NM
stdout channel. This reduces first-use friction to a single click while
preserving the security properties established in RFC0001.

---

# 1. Architecture: Bridge Lifecycle Model

## 1.1 Core Principle

The Bridge main process is **owned by the MCP Host**.

```
MCP Host (e.g. Claude Desktop)
    │
    │  spawns via stdio (JSON-RPC 2.0)
    ▼
brp-bridge --mode=bridge       ← main process (WS server, IPC server, token authority)
    │
    │  WebSocket
    ▼
Firefox Extension              ← browser-side runtime
```

Normative rules:

- The MCP Host SHALL spawn `brp-bridge --mode=bridge` as a child process
  connected via stdin/stdout.
- The MCP Host SHALL be the sole lifecycle owner: it starts, restarts, and
  terminates the Bridge.
- Native Messaging SHALL be used exclusively for **token bootstrap**. It SHALL
  NOT control Bridge lifecycle.
- Closing the browser SHALL NOT terminate the Bridge or interrupt the AI
  session.

---

## 1.2 Dual-Mode Binary Design

The same `brp-bridge` binary operates in one of two mutually exclusive modes.

| Property             | `--mode=bridge` (default)        | `--mode=bootstrap`                        |
|-----------------------|----------------------------------|--------------------------------------------|
| **Spawner**           | MCP Host (Claude Desktop, etc.)  | Firefox (`connectNative`)                  |
| **Lifetime**          | Long-running (session-scoped)    | Ephemeral (single request)                 |
| **stdio role**        | JSON-RPC 2.0 MCP transport       | NM stdout (4-byte LE + JSON)              |
| **WebSocket server**  | Yes                              | No                                         |
| **IPC server**        | Yes (listens)                    | No (client)                                |
| **Token management**  | Generates, stores, rotates       | Reads from main via IPC, writes to stdout  |
| **Exit condition**    | MCP Host closes stdin or sends `exit` | Token written (or error), then exit   |

Invocation examples:

```bash
# MCP Host spawns Bridge
brp-bridge --mode=bridge

# Firefox spawns bootstrap (via NM manifest)
brp-bridge --mode=bootstrap
```

Both modes share the same binary to guarantee:

- Token format consistency
- IPC protocol compatibility
- Simplified distribution (single artifact)
- Atomic version upgrades

---

## 1.3 Rationale

### Why not let the browser spawn the Bridge?

If Firefox spawned the Bridge via NM, closing the browser would kill the NM
child process, which would terminate the Bridge and sever the MCP session. This
is unacceptable because:

1. Users frequently restart browsers without expecting their AI assistant
   session to be interrupted.
2. The MCP Host has no mechanism to detect or recover from externally terminated
   Bridge processes.
3. Bridge state (active sessions, capability cache, event sequence counters) is
   expensive to reconstruct.

By keeping Bridge ownership with the MCP Host, browser lifecycle becomes
independent of AI session lifecycle.

### Why dual-mode instead of two binaries?

A single binary eliminates version skew between the IPC client and server. Both
modes share the same IPC message types, token format, and platform abstraction
layer. Distribution is simplified: the NM manifest and the MCP Host config both
reference the same executable path.

---

# 2. IPC Discovery Protocol

## 2.1 Main Process Startup Sequence

When the MCP Host spawns `brp-bridge --mode=bridge`, the main process SHALL
execute the following sequence:

```
1. Generate instance_id (UUID v4)
2. Create data directory (~/.brp-bridge/instances/) if absent
3. Create IPC endpoint (platform-specific)
4. Write PID lockfile
5. Begin IPC accept loop
6. Begin WebSocket listen on ephemeral port
7. Begin stdin JSON-RPC processing
```

Step-by-step:

**Step 1 -- Generate instance ID:**

```rust
let instance_id = Uuid::new_v4().to_string();
// e.g. "a3f7c91e-4b2d-4e8a-9c6f-1d2e3f4a5b6c"
```

**Step 3 -- Create IPC endpoint:**

| Platform         | IPC endpoint path                                              |
|------------------|----------------------------------------------------------------|
| Linux            | `$XDG_RUNTIME_DIR/brp-bridge/<instance_id>.sock`              |
| Linux (fallback) | `~/.brp-bridge/sockets/<instance_id>.sock`                     |
| macOS            | `$TMPDIR/brp-bridge/<instance_id>.sock` (typically `/var/folders/...`) |
| macOS (fallback) | `~/.brp-bridge/sockets/<instance_id>.sock`                     |
| Windows          | `\\.\pipe\brp-bridge-<instance_id>`                            |

**Step 4 -- Write PID lockfile:**

The lockfile path is:

```
~/.brp-bridge/instances/<pid>.json
```

See Section 2.5 for the full schema.

**Step 5 -- IPC accept loop:**

The main process SHALL accept IPC connections and respond to `request_token`
messages (see Section 2.3). The IPC server SHALL handle concurrent connections
to accommodate multiple bootstrap processes.

---

## 2.2 Bootstrap Process Discovery Flow

When Firefox spawns `brp-bridge --mode=bootstrap` via `connectNative()`, the
bootstrap process SHALL execute:

```
1. Scan lockfile directory for *.json files
2. For each lockfile:
   a. Parse JSON
   b. Verify PID is alive (OS-specific check)
   c. If dead → delete lockfile + socket file → continue to next
   d. If alive → add to candidate list
3. If no candidates → write error to stdout → exit
4. Select MRU (Most Recently Used) instance by started_at timestamp
5. Connect to candidate's IPC endpoint
6. Send request_token message
7. Receive token_response
8. Write NM-formatted message to stdout
9. Exit 0
```

### PID liveness verification

| Platform | Method                                                       |
|----------|--------------------------------------------------------------|
| Linux    | `kill(pid, 0)` returns 0 or EPERM (process exists)          |
| macOS    | `kill(pid, 0)` returns 0 or EPERM (process exists)          |
| Windows  | `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)` succeeds |

If the PID check fails with ESRCH (Linux/macOS) or the handle is invalid
(Windows), the process is considered dead.

### MRU selection

When multiple live Bridge instances exist (e.g., multiple MCP Hosts running),
the bootstrap process SHALL select the instance with the most recent
`started_at` timestamp. This heuristic targets the Bridge most likely to be
actively used.

---

## 2.3 IPC Message Format

All IPC messages are newline-delimited JSON (one JSON object per `\n`-terminated
line). This simplifies framing over stream-oriented sockets and named pipes.

### request_token

Sent by the bootstrap process to the main process.

```json
{
  "type": "request_token",
  "version": 1,
  "requester": {
    "pid": 58432,
    "ppid": 1204,
    "binary_path": "/usr/local/bin/brp-bridge"
  }
}
```

| Field             | Type    | Required | Description                                 |
|-------------------|---------|----------|---------------------------------------------|
| `type`            | string  | Yes      | MUST be `"request_token"`                   |
| `version`         | integer | Yes      | IPC protocol version (currently `1`)        |
| `requester.pid`   | integer | Yes      | PID of the bootstrap process                |
| `requester.ppid`  | integer | Yes      | Parent PID (i.e., Firefox process PID)      |
| `requester.binary_path` | string  | No  | Path to the bootstrap binary (for auditing) |

### token_response (success)

Sent by the main process upon successful token retrieval.

```json
{
  "type": "token_response",
  "version": 1,
  "success": true,
  "token": "brp_tok_a1b2c3d4e5f6...",
  "ws_port": 54321,
  "ws_path": "/brp",
  "instance_id": "a3f7c91e-4b2d-4e8a-9c6f-1d2e3f4a5b6c",
  "expires_at": "2026-06-27T16:00:00Z"
}
```

| Field          | Type    | Required | Description                                     |
|----------------|---------|----------|-------------------------------------------------|
| `type`         | string  | Yes      | MUST be `"token_response"`                      |
| `version`      | integer | Yes      | IPC protocol version                            |
| `success`      | boolean | Yes      | `true`                                          |
| `token`        | string  | Yes      | The session token                               |
| `ws_port`      | integer | Yes      | WebSocket server port on localhost              |
| `ws_path`      | string  | Yes      | WebSocket path (typically `"/brp"`)             |
| `instance_id`  | string  | Yes      | Bridge instance UUID                            |
| `expires_at`   | string  | Yes      | Token expiration (ISO 8601)                     |

### token_response (error)

```json
{
  "type": "token_response",
  "version": 1,
  "success": false,
  "error": {
    "code": "BRP_TOKEN_NOT_READY",
    "message": "Token has not been generated yet"
  }
}
```

| Field             | Type   | Required | Description                           |
|-------------------|--------|----------|---------------------------------------|
| `success`         | boolean| Yes      | `false`                               |
| `error.code`      | string | Yes      | Machine-readable error code           |
| `error.message`   | string | Yes      | Human-readable description            |

Defined error codes for IPC:

| Code                      | Meaning                                      |
|---------------------------|----------------------------------------------|
| `BRP_TOKEN_NOT_READY`     | Bridge started but token not yet generated   |
| `BRP_TOKEN_REVOKED`       | Token was revoked, awaiting regeneration     |
| `BRP_IPC_VERSION_MISMATCH`| Bootstrap IPC version incompatible           |
| `BRP_IPC_INTERNAL_ERROR`  | Unexpected Bridge-side failure               |

---

## 2.4 Native Messaging Output Format

The bootstrap process writes its response to stdout using the standard Native
Messaging wire format:

```
[4-byte little-endian message length][UTF-8 JSON payload]
```

### Success payload

```json
{
  "success": true,
  "token": "brp_tok_a1b2c3d4e5f6...",
  "ws_port": 54321,
  "ws_path": "/brp",
  "instance_id": "a3f7c91e-4b2d-4e8a-9c6f-1d2e3f4a5b6c",
  "expires_at": "2026-06-27T16:00:00Z"
}
```

### Error payload

```json
{
  "success": false,
  "error": {
    "code": "BRP_BRIDGE_NOT_RUNNING",
    "message": "No running Bridge instance found"
  }
}
```

Defined NM error codes:

| Code                          | Meaning                                           |
|-------------------------------|---------------------------------------------------|
| `BRP_BRIDGE_NOT_RUNNING`      | No live Bridge instance discovered                |
| `BRP_IPC_CONNECT_FAILED`      | IPC socket/pipe connection failed                 |
| `BRP_IPC_TIMEOUT`             | No response from Bridge within timeout (5s)       |
| `BRP_IPC_PROTOCOL_ERROR`      | Malformed or unexpected IPC response               |
| `BRP_BOOTSTRAP_INTERNAL_ERROR`| Unhandled error in bootstrap process              |

The extension SHALL inspect `success` and `error.code` to determine user-facing
behavior (e.g., prompt for manual token entry, show "start MCP host first"
message, or retry with backoff).

### Wire format example (hex)

For a 62-byte JSON payload:

```
3E 00 00 00 7B 22 73 75 63 63 ...
|--length--| |------ JSON ------...
   (62 LE)
```

---

## 2.5 PID Lockfile Schema

Lockfiles are written to:

```
~/.brp-bridge/instances/<pid>.json
```

where `<pid>` is the OS process ID of the Bridge main process.

### Schema

```json
{
  "pid": 12345,
  "ipc_path": "/run/user/1000/brp-bridge/a3f7c91e-4b2d-4e8a-9c6f-1d2e3f4a5b6c.sock",
  "ws_port": 54321,
  "started_at": "2026-06-27T10:30:00Z",
  "instance_id": "a3f7c91e-4b2d-4e8a-9c6f-1d2e3f4a5b6c",
  "version": "0.3.1"
}
```

| Field          | Type    | Required | Description                                          |
|----------------|---------|----------|------------------------------------------------------|
| `pid`          | integer | Yes      | OS process ID of the Bridge main process             |
| `ipc_path`     | string  | Yes      | Full path to the IPC endpoint (socket or named pipe) |
| `ws_port`      | integer | Yes      | WebSocket server port on localhost                   |
| `started_at`   | string  | Yes      | ISO 8601 timestamp of process start                  |
| `instance_id`  | string  | Yes      | UUID v4 instance identifier                          |
| `version`      | string  | Yes      | Bridge binary version (semver)                       |

### Lockfile lifecycle

1. **Written** after IPC endpoint is successfully created (Section 2.1, step 4).
2. **Updated** if `ws_port` changes (e.g., port conflict retry).
3. **Deleted** on graceful shutdown (SIGTERM, stdin close, `exit` message).
4. **Cleaned** by bootstrap processes that detect a dead PID (Section 2.6).

The main process SHALL attempt to delete its lockfile in a shutdown handler.
Implementations SHOULD also register an `atexit` handler as a safety net.

---

## 2.6 Stale Socket Handling

When the bootstrap process discovers a lockfile whose PID is no longer alive,
it SHALL perform the following cleanup:

```
1. Delete the lockfile: ~/.brp-bridge/instances/<pid>.json
2. If ipc_path points to a Unix domain socket:
   a. Delete the socket file from the filesystem
   b. If the parent directory is empty, remove the directory
3. If ipc_path points to a named pipe:
   a. No filesystem cleanup needed (OS reclaims on process exit)
4. Continue scanning remaining lockfiles
```

### Race condition guard

Between the PID liveness check and the socket deletion, a new process MAY reuse
the same PID. To mitigate this:

1. Read the lockfile's `instance_id`.
2. Verify the socket file still exists and its path contains the same
   `instance_id`.
3. Only delete if both match.

This reduces (but does not eliminate) the risk of deleting a socket belonging to
a legitimately reused PID. The window is small enough that the probability is
negligible in practice.

---

## 2.7 Startup Order Matrix

| # | Scenario                                           | Bootstrap behavior                                                       | Extension behavior                                                    |
|---|----------------------------------------------------|--------------------------------------------------------------------------|-----------------------------------------------------------------------|
| 1 | MCP started first, extension connects later        | Discovers live instance, retrieves token, writes to stdout, exits        | Receives token via NM `onMessage`, connects WebSocket, begins session |
| 2 | Extension connects first, MCP not running           | Scans lockfiles, finds no live instance                                  | Receives `BRP_BRIDGE_NOT_RUNNING` error, shows "Start MCP host first" UI |
| 3 | Extension reload (e.g., `about:addons` toggle)     | Re-runs `connectNative()`, spawns new bootstrap                          | New bootstrap discovers existing Bridge (unaffected by extension reload), retrieves token, connects WS |
| 4 | Bridge crash, MCP auto-restarts Bridge             | New Bridge starts with new `instance_id`, writes new lockfile            | Extension WS disconnects, reconnects with exponential backoff (1s, 2s, 4s, 8s, max 30s), re-runs bootstrap on next NM cycle |
| 5 | Standalone mode (`BRP_STANDALONE=1`)               | NM bootstrap disabled entirely                                           | Extension checks `supportsAutoLink` in `initialize` response capability; falls back to manual token input in Options page |

### Standalone mode detail

When the environment variable `BRP_STANDALONE=1` is set:

- The Bridge SHALL NOT create an IPC endpoint or write a lockfile.
- The Bridge SHALL set `"supportsAutoLink": false` in the `initialize` response
  capabilities.
- The extension SHALL detect this capability and render the manual token input
  UI.

```json
{
  "result": {
    "capabilities": {
      "supportsAutoLink": false,
      "features": ["interactionTree", "events"]
    }
  }
}
```

---

## 2.8 Platform-Specific IPC Implementation

The IPC layer uses tokio's native platform APIs directly. The `interprocess`
crate is intentionally NOT used, to minimize dependencies and maintain control
over error handling and lifetime management.

### Linux / macOS

```
IPC endpoint: Unix domain socket
Server:       tokio::net::UnixListener
Client:       tokio::net::UnixStream
```

**Server (Bridge mode):**

```rust
use tokio::net::UnixListener;

let socket_path = resolve_ipc_path(&instance_id);
// Ensure parent directory exists
std::fs::create_dir_all(socket_path.parent().unwrap())?;
// Remove stale socket if present
let _ = std::fs::remove_file(&socket_path);
let listener = UnixListener::bind(&socket_path)?;

loop {
    let (stream, _addr) = listener.accept().await?;
    tokio::spawn(handle_ipc_connection(stream, token_store.clone()));
}
```

**Client (bootstrap mode):**

```rust
use tokio::net::UnixStream;

let stream = UnixStream::connect(&ipc_path).await?;
// Send request_token, read token_response (newline-delimited JSON)
```

Socket file permissions SHALL be set to `0o600` (owner read/write only) to
prevent other users from connecting.

### Windows

```
IPC endpoint: Named pipe
Server:       tokio::net::windows::named_pipe::ServerOptions
Client:       tokio::net::windows::named_pipe::ClientOptions
```

**Server (Bridge mode):**

```rust
use tokio::net::windows::named_pipe::ServerOptions;

let pipe_name = format!(r"\\.\pipe\brp-bridge-{}", instance_id);
let mut server = ServerOptions::new()
    .first_pipe_instance(true)
    .create(&pipe_name)?;

loop {
    server.connect().await?;
    let client = server;
    server = ServerOptions::new().create(&pipe_name)?;
    tokio::spawn(handle_ipc_connection(client, token_store.clone()));
}
```

**Client (bootstrap mode):**

```rust
use tokio::net::windows::named_pipe::ClientOptions;

let pipe_name = format!(r"\\.\pipe\brp-bridge-{}", instance_id);
let client = ClientOptions::new().open(&pipe_name)?;
// Send request_token, read token_response (newline-delimited JSON)
```

### Thin platform abstraction

Both platforms are wrapped behind a trait to isolate platform-specific code:

```rust
#[async_trait]
pub trait IpcServer: Send + Sync {
    async fn accept(&self) -> Result<Box<dyn IpcStream>>;
    fn endpoint_path(&self) -> &str;
}

#[async_trait]
pub trait IpcStream: AsyncRead + AsyncWrite + Send + Unpin {
    // Shared framing: newline-delimited JSON
}

#[async_trait]
pub trait IpcClient: Send + Sync {
    async fn connect(path: &str) -> Result<Box<dyn IpcStream>>;
}
```

Platform modules:

```
src/
  ipc/
    mod.rs          # trait definitions + cfg-gated re-exports
    unix.rs         # UnixListener/UnixStream implementation
    windows.rs      # named_pipe implementation
```

Compile-time selection via `#[cfg(unix)]` and `#[cfg(windows)]`. No runtime
platform detection is needed.

### IPC timeout

The bootstrap process SHALL apply a 5-second timeout to the entire
connect-send-receive cycle. If the timeout elapses, the bootstrap writes a
`BRP_IPC_TIMEOUT` error to stdout and exits.

---

# 3. Threat Model

## 3.1 Trust Domain

BRP operates within a **same-user trust domain**. All components (MCP Host,
Bridge, bootstrap process, Firefox extension) are assumed to run under the same
OS user account.

## 3.2 Token Scope

The session token defends against:

- **Cross-Site WebSocket Hijacking (CSWSH):** The WS server requires a valid
  token in the connection handshake. A malicious website cannot open a WebSocket
  to `localhost` without the token.
- **DNS rebinding:** The token is bound to `localhost` / `127.0.0.1`. Even if an
  attacker tricks DNS, the token is required.
- **Cross-user access:** On multi-user systems, the token prevents other local
  users from connecting to the Bridge.

## 3.3 Out of Scope

The following are explicitly out of scope for BRP:

- **Same-user process interception:** A malicious process running as the same
  user could read the lockfile, connect to the IPC socket, and request a token.
  Defending against this requires OS-level sandboxing (e.g., AppArmor, SELinux,
  macOS sandbox profiles) which is beyond BRP's control.
- **Compromised MCP Host:** If the MCP Host itself is compromised, the attacker
  already has full Bridge access.
- **Network attackers:** BRP communicates only over `localhost`. Network-level
  attacks are mitigated by the loopback binding.

## 3.4 Socket File Permissions

On Unix systems, the IPC socket file SHALL be created with permissions `0o600`
(owner read/write only). The lockfile SHALL also be `0o600`. This provides
defense-in-depth against casual cross-user access even though it is not the
primary security boundary.

## 3.5 Windows Named Pipe ACL (TODO for v0.4.0)

On Windows, `tokio::net::windows::named_pipe::ServerOptions` creates Named
Pipes that are **accessible to all users on the machine** by default. This is
wider than the Unix `0o600` socket permissions and violates the same-user
trust domain assumption declared in §3.1.

**Production implementation MUST:**

1. Create a `SECURITY_ATTRIBUTES` structure with a DACL that grants
   `GENERIC_READ | GENERIC_WRITE` only to the current user's SID.
2. Pass this via `ServerOptions::create_with_security_attributes()` (requires
   `windows-sys` or `winapi` crate for constructing the security descriptor).

**Spike status:** The B1 IPC spike (`spikes/b1-ipc-spike/`) does **not** set
pipe ACLs. This is acceptable for the spike (validation of tokio's Named Pipe
API), but the production implementation in v0.4.0 **must** address this before
shipping. If constructing a per-user DACL proves impractical with tokio's
current API, fallback options include:

- Using a shared secret in the pipe name (e.g., `brp-bridge-<instance_id>-<random_suffix>`)
  so the pipe name itself is unguessable, though this is security through obscurity.
- Falling back to localhost TCP loopback with a per-session binding token,
  though this re-introduces a network attack surface.

The preferred path is explicit DACL construction. This will be validated
during the v0.3.2 spike cross-platform phase.

---

# 4. Future Chapters (Planned for v0.3.2)

The following chapters are **not yet written**. They will be completed in
v0.3.2 after the B1 spike validates cross-platform IPC behavior.

| Chapter | Title                          | Status      | Depends On                                    |
|---------|--------------------------------|-------------|-----------------------------------------------|
| §4      | Installation & Distribution    | Planned     | Spike validates manifest path detection       |
| §5      | Token Bootstrap Protocol       | Planned     | Spike validates IPC message format            |
| §6      | Extension-Side Implementation  | Planned     | §5 defines the protocol                       |
| §7      | Crash Recovery & Reconnection  | Planned     | Spike validates stale lockfile cleanup        |
| §8      | Multi-Browser Support          | Planned     | §4 covers per-browser manifest paths          |

**Dependency chain:** Spike cross-platform validation (§2.8, §3.5, §7) must
complete before RFC chapters are finalized. This prevents committing to
designs that the spike later proves infeasible.

---

# References

- **RFC0001** -- Browser Runtime Protocol Core Specification (protocol
  foundation, session lifecycle, security model)
- **RFC0000** -- BRP RFC Process
- **Mozilla MDN** -- [Native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- **JSON-RPC 2.0** -- [Specification](https://www.jsonrpc.org/specification)
- **tokio** -- [Unix domain sockets](https://docs.rs/tokio/latest/tokio/net/struct.UnixListener.html), [Windows named pipes](https://docs.rs/tokio/latest/tokio/net/windows/named_pipe/index.html)

---

# Changelog

| Version | Date       | Changes                                    |
|---------|------------|--------------------------------------------|
| 0.3.1   | 2026-06-27 | Initial draft: Chapters 1-3, References    |
