# RFC-B1: Native Messaging Auto-Link

- **RFC Number:** B1
- **Title:** Native Messaging Auto-Link
- **Status:** Draft
- **Author:** tomjiu
- **Version:** 0.3.2
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

# 4. Installation & Distribution

For Firefox to spawn the bootstrap process via `browser.runtime.connectNative()`,
a Native Messaging manifest file MUST be present at a platform-specific location.
This section defines the manifest format, installation paths, and the automated
install mechanism.

## 4.1 Native Messaging Manifest

The manifest is a JSON file named `org.brp.bridge.json` that tells Firefox where
to find the bootstrap binary and which extensions are permitted to invoke it.

### Schema

```json
{
  "name": "org.brp.bridge",
  "description": "BRP Bridge Native Messaging Host",
  "path": "/absolute/path/to/brp-bridge",
  "type": "stdio",
  "allowed_extensions": ["brp-extension@yourdomain.com"]
}
```

| Field                | Type       | Required | Description                                              |
|----------------------|------------|----------|----------------------------------------------------------|
| `name`               | string     | Yes      | MUST be `"org.brp.bridge"`. Used as the argument to `connectNative()`. |
| `description`        | string     | Yes      | Human-readable description shown in `about:addons`.      |
| `path`               | string     | Yes      | Absolute path to the `brp-bridge` binary. MUST NOT contain relative components. |
| `type`               | string     | Yes      | MUST be `"stdio"`. Firefox communicates via stdin/stdout. |
| `allowed_extensions` | string[]   | Yes      | List of extension IDs permitted to invoke this host.     |

The `path` field SHALL point to a binary that accepts `--mode=bootstrap` (see
Section 1.2). The binary MUST be executable by the OS user running Firefox.

---

## 4.2 Platform Manifest Paths

Firefox reads the manifest from a well-known directory determined by the
operating system and browser variant.

| Platform              | Manifest directory                                                          | Install method                              |
|-----------------------|-----------------------------------------------------------------------------|---------------------------------------------|
| Linux (Firefox)       | `~/.mozilla/native-messaging-hosts/org.brp.bridge.json`                     | `install.sh` or `brp-bridge --install`      |
| macOS (Firefox)       | `~/Library/Application Support/Mozilla/NativeMessagingHosts/org.brp.bridge.json` | `install.sh` or `brp-bridge --install` |
| Windows (Firefox)     | Registry `HKCU\Software\Mozilla\NativeMessagingHosts\org.brp.bridge`        | `install.ps1` or `brp-bridge --install`     |
| Linux (Flatpak/Zen)   | `~/.var/app/org.mozilla.firefox/app/native-messaging-hosts/` (or Zen path)  | Documentation + manual; P3 priority         |

### Linux

The manifest file is placed in:

```
~/.mozilla/native-messaging-hosts/org.brp.bridge.json
```

If the directory `~/.mozilla/native-messaging-hosts/` does not exist, the
installer SHALL create it with permissions `0o755`.

### macOS

The manifest file is placed in:

```
~/Library/Application Support/Mozilla/NativeMessagingHosts/org.brp.bridge.json
```

If the directory does not exist, the installer SHALL create it with permissions
`0o755`.

### Windows

Firefox on Windows does not use a file-based manifest. Instead, a registry key
is created:

```
HKCU\Software\Mozilla\NativeMessagingHosts\org.brp.bridge
    (Default) = REG_SZ "C:\absolute\path\to\org.brp.bridge.json"
```

The registry value points to the manifest JSON file, which is written alongside
the binary (e.g., `C:\Program Files\BRP\org.brp.bridge.json`). The installer
SHALL create both the registry key and the manifest file.

### Flatpak / Zen Browser

Flatpak-sandboxed Firefox (and Zen Browser variants) use a separate data
directory that is isolated from the host filesystem:

```
~/.var/app/org.mozilla.firefox/app/native-messaging-hosts/org.brp.bridge.json
```

The exact path varies by Flatpak application ID and browser fork. Because
Flatpak installations differ significantly across distributions, automated
installation is **not** provided in the initial release. Users SHALL follow
manual documentation to place the manifest in the correct directory. Flatpak
support is tracked as a P3 priority.

---

## 4.3 `--install` Behavior

The `brp-bridge --install` command automates manifest installation. It SHALL
execute the following sequence:

```
1. Detect platform (Linux, macOS, Windows)
2. Detect browser variant (Firefox, Zen, Flatpak Firefox)
3. Resolve manifest target path (see Section 4.2)
4. Compute the absolute path of the current brp-bridge binary
5. Generate manifest JSON with `path` set to the binary's absolute path
6. Write manifest to the target location
7. Verify the written file is readable
8. Print success message with manifest path
```

### Platform detection

| Platform | Detection method                                          |
|----------|-----------------------------------------------------------|
| Linux    | `std::env::consts::OS == "linux"` and no Flatpak marker   |
| macOS    | `std::env::consts::OS == "macos"`                         |
| Windows  | `std::env::consts::OS == "windows"`                        |
| Flatpak  | `/run/host/os-release` exists or `FLATPAK_ID` env var set |

### Browser variant detection

The installer SHALL probe for the following browser variants in order:

1. **Standard Firefox** -- check default manifest directory exists or can be
   created.
2. **Zen Browser** -- check for Zen-specific config directories (e.g.,
   `~/.zen/` on Linux, `~/Library/Application Support/Zen/` on macOS).
3. **Flatpak Firefox** -- check for `~/.var/app/org.mozilla.firefox/`.

If multiple variants are detected, the installer SHALL install for all detected
variants and print each manifest path.

### Binary path resolution

The installer SHALL resolve its own absolute path using:

```rust
let exe_path = std::env::current_exe()?
    .canonicalize()?;
```

This path is written into the manifest's `path` field. The path MUST be
canonicalized to resolve symlinks, ensuring Firefox can locate the binary even
if it was installed via a symlinked wrapper (e.g., Homebrew, Nix).

### Non-invasive failure

If the installer lacks permissions to write to the target directory (e.g.,
system-wide install on Linux), it SHALL NOT attempt privilege escalation.
Instead, it SHALL:

1. Print the manifest JSON to stdout.
2. Print the manual commands needed to install it:

```
# Manual installation required:
mkdir -p ~/.mozilla/native-messaging-hosts/
cp /tmp/org.brp.bridge.json ~/.mozilla/native-messaging-hosts/
```

This ensures the installer is safe to run in unattended or CI environments
without risk of unexpected privilege prompts.

### Windows registry write

On Windows, the installer SHALL:

1. Write the manifest JSON file to the same directory as the binary.
2. Create the registry key `HKCU\Software\Mozilla\NativeMessagingHosts\org.brp.bridge`.
3. Set the `(Default)` value to the absolute path of the manifest JSON file.

If registry write fails (e.g., group policy restriction), the installer SHALL
print the `.reg` file contents for manual import:

```
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\Mozilla\NativeMessagingHosts\org.brp.bridge]
@="C:\\Program Files\\BRP\\org.brp.bridge.json"
```

---

## 4.4 Install Scripts

### `install.sh` (Linux / macOS)

A POSIX-compatible shell script distributed alongside the binary. It SHALL:

1. Verify `brp-bridge` is on `$PATH` or in the same directory as the script.
2. Resolve the absolute path to `brp-bridge`.
3. Create the target directory if absent.
4. Write the manifest JSON.
5. Print a success or failure message.

```bash
#!/bin/sh
set -e

BINARY="$(cd "$(dirname "$0")" && pwd)/brp-bridge"
if [ ! -x "$BINARY" ]; then
  echo "Error: brp-bridge not found or not executable" >&2
  exit 1
fi

if [ "$(uname)" = "Darwin" ]; then
  DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
else
  DIR="$HOME/.mozilla/native-messaging-hosts"
fi

mkdir -p "$DIR"
cat > "$DIR/org.brp.bridge.json" <<EOF
{
  "name": "org.brp.bridge",
  "description": "BRP Bridge Native Messaging Host",
  "path": "$BINARY",
  "type": "stdio",
  "allowed_extensions": ["brp-extension@yourdomain.com"]
}
EOF

echo "Installed manifest to $DIR/org.brp.bridge.json"
```

### `install.ps1` (Windows)

A PowerShell script that SHALL:

1. Locate `brp-bridge.exe` relative to the script or on `$env:PATH`.
2. Write the manifest JSON alongside the binary.
3. Create the Firefox registry key.
4. Set the registry value to the manifest path.

```powershell
$ErrorActionPreference = "Stop"

$BinaryDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinaryPath = Join-Path $BinaryDir "brp-bridge.exe"
$ManifestPath = Join-Path $BinaryDir "org.brp.bridge.json"

if (-not (Test-Path $BinaryPath)) {
    Write-Error "brp-bridge.exe not found in $BinaryDir"
    exit 1
}

$Manifest = @{
    name = "org.brp.bridge"
    description = "BRP Bridge Native Messaging Host"
    path = $BinaryPath
    type = "stdio"
    allowed_extensions = @("brp-extension@yourdomain.com")
} | ConvertTo-Json

Set-Content -Path $ManifestPath -Value $Manifest -Encoding UTF8

$RegPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\org.brp.bridge"
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestPath

Write-Host "Installed manifest and registry key."
```

---

## 4.5 Uninstallation

The `brp-bridge --uninstall` command SHALL reverse the installation:

| Platform | Action                                                                 |
|----------|------------------------------------------------------------------------|
| Linux    | Delete `~/.mozilla/native-messaging-hosts/org.brp.bridge.json`. Remove parent directory if empty. |
| macOS    | Delete `~/Library/Application Support/Mozilla/NativeMessagingHosts/org.brp.bridge.json`. Remove parent directory if empty. |
| Windows  | Delete registry key `HKCU\...\org.brp.bridge`. Delete manifest JSON file alongside the binary. |

The uninstaller SHALL NOT delete the `brp-bridge` binary itself, as it may be
managed by an external package manager.

---

# 5. Token Bootstrap Protocol

This section defines the end-to-end protocol by which the Firefox extension
obtains a session token from the running Bridge and establishes a WebSocket
connection. It builds on the IPC mechanism (Section 2) and NM output format
(Section 2.4) defined earlier, adding the bootstrap-specific message flow,
error handling, and token lifecycle rules.

## 5.1 Connection Sequence

The complete handshake from extension invocation to WebSocket registration:

```
Extension                    Bootstrap (NM child)              Bridge (main process)
   │                              │                                │
   │ 1. connectNative("org.brp.bridge")                            │
   │──────────────────────────────>                                │
   │                              │  Firefox spawns brp-bridge      │
   │                              │  --mode=bootstrap               │
   │                              │                                │
   │                              │ 2. Scan lockfiles, select MRU  │
   │                              │────────────────────────────────>
   │                              │ 3. IPC: request_token          │
   │                              │────────────────────────────────>
   │                              │ 4. IPC: token_response         │
   │                              │<────────────────────────────────
   │                              │                                │
   │ 5. NM onMessage(token, ws_port)                               │
   │<──────────────────────────────                                │
   │                              │ 6. Exit 0                      │
   │                              X                                │
   │ 7. WS connect ws://127.0.0.1:<ws_port>?token=<token>         │
   │──────────────────────────────────────────────────────────────>
   │                              │                                │
   │                              │          8. Validate token      │
   │                              │          9. Register client     │
   │ 10. WS open confirmed        │                                │
   │<──────────────────────────────────────────────────────────────
```

### Step-by-step description

1. **Extension calls `connectNative`.** The extension invokes
   `browser.runtime.connectNative("org.brp.bridge")`. Firefox reads the
   manifest at the platform-specific path (Section 4.2) and spawns the binary
   listed in the `path` field with the arguments `--mode=bootstrap`.

2. **Bootstrap discovers Bridge.** The bootstrap process scans
   `~/.brp-bridge/instances/*.json`, verifies PID liveness, and selects the
   MRU instance (Section 2.2).

3. **Bootstrap sends `request_token`.** The bootstrap connects to the Bridge's
   IPC endpoint and sends a `request_token` message (Section 5.2).

4. **Bridge responds with `token_response`.** The Bridge validates the request
   and returns the current session token, WebSocket port, and metadata
   (Section 5.2).

5. **Bootstrap writes NM message.** The bootstrap serializes the token
   response into the NM wire format (Section 5.3) and writes it to stdout.
   Firefox delivers this to the extension via the NM port's `onMessage`
   callback.

6. **Bootstrap exits.** After writing the NM message, the bootstrap process
   SHALL exit with code 0 (success) or code 1 (error). The NM port is closed
   by Firefox after the child process exits.

7. **Extension connects WebSocket.** The extension opens a WebSocket connection
   to `ws://127.0.0.1:<ws_port>` and includes the token in the connection
   handshake (query parameter or first message, per RFC0001).

8. **Bridge validates token.** The Bridge performs a constant-time comparison
   of the presented token against the stored session token (Section 5.5).

9. **Bridge registers client.** Upon successful validation, the Bridge
   registers the extension as an authenticated WebSocket client.

10. **Connection confirmed.** The WebSocket is open and bidirectional
    communication begins.

---

## 5.2 IPC Message Format (Bootstrap-Specific)

The bootstrap process communicates with the Bridge over the IPC channel defined
in Section 2.3. The following messages are specific to the bootstrap flow.

### request_token

Sent by the bootstrap process to the Bridge over IPC.

```json
{
  "type": "request_token",
  "data": {
    "browser_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```

| Field           | Type   | Required | Description                                                 |
|-----------------|--------|----------|-------------------------------------------------------------|
| `type`          | string | Yes      | MUST be `"request_token"`                                   |
| `data.browser_id` | string | Yes    | UUID v4 identifying the browser instance making the request |

The `browser_id` is generated by the extension at install time and persisted in
extension storage. It allows the Bridge to audit which browser instances have
requested tokens and to enforce per-browser rate limits.

### token_response (success)

Returned by the Bridge when the token is available and the request is accepted.

```json
{
  "type": "token_response",
  "data": {
    "token": "e2b7f4a1-9c3d-4e5f-8a6b-1d2c3e4f5a6b",
    "ws_port": 9817
  }
}
```

| Field          | Type    | Required | Description                                      |
|----------------|---------|----------|--------------------------------------------------|
| `type`         | string  | Yes      | MUST be `"token_response"`                       |
| `data.token`   | string  | Yes      | The session token (UUID v4)                      |
| `data.ws_port` | integer | Yes      | WebSocket server port on `127.0.0.1`             |

### token_response (error)

Returned when the Bridge rejects the request.

```json
{
  "type": "token_error",
  "data": {
    "code": "BRP_BRIDGE_NOT_RUNNING",
    "message": "No live Bridge instance found"
  }
}
```

| Field             | Type   | Required | Description                          |
|-------------------|--------|----------|--------------------------------------|
| `type`            | string | Yes      | MUST be `"token_error"`              |
| `data.code`       | string | Yes      | Machine-readable error code          |
| `data.message`    | string | Yes      | Human-readable description           |

---

## 5.3 Bootstrap Error Codes

The following error codes MAY be returned in a `token_error` message or
written to the NM stdout error payload (Section 2.4):

| Code                          | Meaning                                                      | Retryable |
|-------------------------------|--------------------------------------------------------------|-----------|
| `BRP_BRIDGE_NOT_RUNNING`      | No live Bridge instance found during lockfile scan           | Yes       |
| `BRP_BRIDGE_BUSY`             | Bridge rejected the connection (rate limit exceeded)         | Yes       |
| `BRP_INVALID_BROWSER_ID`      | `browser_id` is not a valid UUID v4                          | No        |
| `BRP_IPC_CONNECT_FAILED`      | Could not connect to the Bridge's IPC endpoint               | Yes       |
| `BRP_IPC_TIMEOUT`             | No IPC response within 5-second timeout                      | Yes       |
| `BRP_IPC_PROTOCOL_ERROR`      | Malformed or unexpected IPC response from Bridge              | No        |
| `BRP_BOOTSTRAP_INTERNAL_ERROR`| Unhandled internal error in the bootstrap process             | No        |

### Retry guidance

For **retryable** errors, the extension SHOULD implement exponential backoff
with the following schedule: 1s, 2s, 4s, 8s, 16s, max 30s. After 5
consecutive failures, the extension SHOULD present a user-facing error with
an option to retry manually.

For **non-retryable** errors, the extension SHALL display a diagnostic message
and direct the user to the troubleshooting documentation.

---

## 5.4 Native Messaging Output Format

After receiving a `token_response` from the Bridge, the bootstrap process
SHALL serialize the result and write it to stdout using the Native Messaging
wire format defined in Section 2.4:

```
[4-byte little-endian message length][UTF-8 JSON payload]
```

### Success output

```json
{
  "token": "e2b7f4a1-9c3d-4e5f-8a6b-1d2c3e4f5a6b",
  "ws_port": 9817
}
```

### Error output

```json
{
  "error": {
    "code": "BRP_BRIDGE_NOT_RUNNING",
    "message": "No running Bridge instance found"
  }
}
```

The extension SHALL check for the presence of the `token` field to determine
success. If `error` is present instead, the extension SHALL use `error.code`
to select the appropriate user-facing behavior (see Section 5.3).

### Maximum message size

Firefox imposes a 1 MB limit on NM messages. The BRP token response is
typically under 200 bytes, well within this limit. The bootstrap process
SHALL NOT produce messages exceeding 1 MB.

---

## 5.5 Token Lifecycle

### Generation

The Bridge SHALL generate a UUID v4 token during startup (Section 2.1, step 1).
The token is the sole credential for WebSocket authentication and MUST be
cryptographically random.

```rust
use uuid::Uuid;

let token = Uuid::new_v4().to_string();
// e.g. "e2b7f4a1-9c3d-4e5f-8a6b-1d2c3e4f5a6b"
```

### Reusability

The token SHALL be **reusable** for multiple WebSocket registration attempts.
Rationale:

1. The extension may need to reconnect after a transient network failure
   (e.g., laptop sleep/wake) without re-running the full bootstrap flow.
2. The Bridge is the sole token authority; there is no external token issuer
   to request fresh tokens from.
3. The token is bound to `127.0.0.1` and defended by the same-user trust
   domain (Section 3.1), so replay risk is limited to same-user processes.

The token SHALL remain valid for the lifetime of the Bridge process instance.

### Validation

The Bridge SHALL validate presented tokens using **constant-time comparison**
to prevent timing side-channel attacks:

```rust
use subtle::ConstantTimeEq;

fn validate_token(presented: &str, stored: &str) -> bool {
    presented.as_bytes().ct_eq(stored.as_bytes()).into()
}
```

If the presented token does not match, the Bridge SHALL close the WebSocket
connection immediately with status code `4401` (Unauthorized) and SHALL NOT
provide further detail in the close frame payload.

### Rotation

The token SHALL be rotated under the following conditions:

| Trigger                          | Behavior                                                        |
|----------------------------------|-----------------------------------------------------------------|
| Bridge process restart           | New UUID v4 generated; old token invalidated                    |
| Explicit revocation via MCP RPC  | Bridge generates new UUID v4; existing WS clients disconnected  |
| `BRP_TOKEN_REVOKED` state        | Bootstrap receives error; extension must re-run bootstrap after Bridge regenerates |

The Bridge SHALL NOT rotate the token on a time-based schedule. Time-based
rotation adds complexity without meaningful security benefit given the
same-user, localhost-only threat model (Section 3.3).

### Token storage

The token SHALL be held in memory only. It SHALL NOT be written to disk,
logged, or transmitted over any channel other than the IPC socket and the
WebSocket handshake. This limits the attack surface to same-user process
memory inspection.

---

## 5.6 Rate Limiting

To prevent a misbehaving or malicious extension from spawning excessive
bootstrap processes, the Bridge SHALL enforce rate limits on `request_token`
IPC messages:

| Parameter               | Value          | Description                                      |
|-------------------------|----------------|--------------------------------------------------|
| Max requests per minute | 10             | Per `browser_id`                                 |
| Concurrent connections  | 5              | Maximum simultaneous IPC connections from bootstrap processes |
| Cooldown after rejection| 5 seconds      | Minimum wait before the same `browser_id` may retry |

If a request is rejected due to rate limiting, the Bridge SHALL respond with:

```json
{
  "type": "token_error",
  "data": {
    "code": "BRP_BRIDGE_BUSY",
    "message": "Rate limit exceeded, retry after 5 seconds"
  }
}
```

---

## 5.7 Bootstrap Process Constraints

The bootstrap process operates under strict constraints to minimize its
attack surface:

1. **Single request.** The bootstrap process SHALL send exactly one
   `request_token` message and read exactly one response. It SHALL NOT
   maintain a persistent IPC connection.

2. **Timeout.** The entire connect-send-receive cycle SHALL be subject to
   a 5-second timeout (Section 2.8). If the timeout elapses, the bootstrap
   writes a `BRP_IPC_TIMEOUT` error to stdout and exits with code 1.

3. **No stdin consumption.** The bootstrap process SHALL NOT read from stdin.
   Firefox provides stdin for NM communication, but the bootstrap only uses
   stdout for the response.

4. **Clean exit.** After writing the NM message (success or error), the
   bootstrap process SHALL close stdout and exit. It SHALL NOT spawn child
   processes, write files, or perform any side effects beyond the NM output.

5. **No environment leakage.** The bootstrap process SHALL NOT include
   environment variables, process arguments, or other host metadata in the
   NM output beyond what is defined in Section 5.4.

---

# 6. Extension-Side Implementation

This section specifies how the Firefox extension invokes the bootstrap flow,
manages the token across sessions, adapts its UI to the Bridge's capabilities,
and handles errors surfaced by the NM channel or the WebSocket layer.

## 6.1 `connectNative` Invocation Timing

The extension SHALL invoke `browser.runtime.connectNative("org.brp.bridge")`
only under the following conditions:

| Trigger                                  | Condition                                                     |
|------------------------------------------|---------------------------------------------------------------|
| **First run (extension install)**        | No cached token exists in `browser.storage.local`             |
| **Extension startup**                    | No cached token exists in `browser.storage.local`             |
| **User clicks "Auto-Link" button**       | User explicitly requests re-link from the Options page        |

The extension SHALL NOT invoke `connectNative` on every page load, tab open, or
navigation event. The bootstrap process spawns a child OS process; invoking it
unnecessarily wastes resources and risks hitting the rate limits defined in
Section 5.6.

### Invocation flow

```
Extension startup
    │
    ├── Read browser.storage.local
    │   ├── cached token exists?
    │   │   ├── YES → attempt WS connect with cached token (§6.2)
    │   │   └── NO  → call connectNative("org.brp.bridge")
    │   │             ├── success → cache token → WS connect
    │   │             └── error   → show error UI (§6.4)
    │   └──
    └──
```

### Debounce

If the extension is rapidly reloaded (e.g., during development with
`about:debugging`), the extension SHALL debounce `connectNative` invocations
to at most one call per 10-second window. This prevents spawning a burst of
bootstrap processes that would trigger the Bridge's rate limiter.

---

## 6.2 Token Caching in Extension Storage

The extension SHALL persist the session token in `browser.storage.local` to
avoid re-running the bootstrap flow on every extension startup.

### Storage schema

```json
{
  "brp_cached_token": "e2b7f4a1-9c3d-4e5f-8a6b-1d2c3e4f5a6b",
  "brp_ws_port": 9817,
  "brp_instance_id": "a3f7c91e-4b2d-4e8a-9c6f-1d2e3f4a5b6c",
  "brp_browser_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "brp_cached_at": "2026-06-27T10:35:00Z"
}
```

| Key                  | Type   | Description                                         |
|----------------------|--------|-----------------------------------------------------|
| `brp_cached_token`   | string | The session token (opaque to the extension)         |
| `brp_ws_port`        | number | WebSocket port from the bootstrap response          |
| `brp_instance_id`    | string | Bridge instance UUID from the bootstrap response    |
| `brp_browser_id`     | string | This browser's persistent identifier (§7.1)         |
| `brp_cached_at`      | string | ISO 8601 timestamp of when the token was cached     |

### Token opacity

The token is **opaque** to the extension. The extension SHALL NOT parse,
validate, or inspect the token value. It SHALL treat it as an arbitrary string
to be passed verbatim to the WebSocket handshake. This decouples the extension
from any future changes to token format.

### Startup reconnection flow

```
Extension startup
    │
    ├── 1. Read brp_cached_token, brp_ws_port, brp_browser_id from storage
    │
    ├── 2. If any required key is missing → run bootstrap (§6.1)
    │
    ├── 3. Open WS to ws://127.0.0.1:<brp_ws_port>?token=<brp_cached_token>
    │       ├── WS open succeeds → session active, skip to step 6
    │       ├── WS connection refused (ECONNREFUSED) → Bridge likely restarted
    │       │   → invalidate cached token → exponential backoff (§7.5)
    │       │   → re-run bootstrap after backoff
    │       └── WS close 4401 (Unauthorized) → token invalid
    │           → invalidate cached token → re-run bootstrap immediately
    │
    └── 6. Begin heartbeat timer (§7.3)
```

### Cache invalidation

The extension SHALL delete the cached token from `browser.storage.local` under
the following conditions:

1. WebSocket connection is refused (`ECONNREFUSED`), indicating the Bridge has
   restarted and the old port is no longer valid.
2. WebSocket close frame with status `4401`, indicating the token is no longer
   accepted (Bridge restarted or token rotated).
3. User clicks "Re-link" in the Options page.
4. Bootstrap returns a new token (the new token overwrites the old one).

---

## 6.3 `supportsAutoLink` Capability

The Bridge advertises its auto-link capability in the `initialize` JSON-RPC
response sent to the MCP Host. This capability determines which UI the
extension Options page SHALL present.

### Capability field

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "capabilities": {
      "supportsAutoLink": true,
      "features": ["interactionTree", "events"]
    }
  }
}
```

| Value    | Meaning                                                                   |
|----------|---------------------------------------------------------------------------|
| `true`   | Bridge is running in managed mode with NM auto-link available             |
| `false`  | Bridge is running in Standalone mode (`BRP_STANDALONE=1`); NM is disabled |

### How the extension learns the capability

The extension does NOT call `initialize` directly — that is an MCP Host concern.
Instead, the extension discovers the capability through one of:

1. **Successful bootstrap + WS connect.** If the bootstrap returned a token and
   the WS handshake succeeded, auto-link is implicitly supported.
2. **Bootstrap error `BRP_BRIDGE_NOT_RUNNING` + no Standalone indicator.** The
   Bridge is simply not started yet; auto-link may be available once started.
3. **Bridge `initialize` response propagated via WS.** After the WS connection
   is established, the Bridge SHALL send a `serverInfo` message that includes
   `supportsAutoLink`. The extension SHALL use this for the Options page UI.

### `serverInfo` message (post-WS-connect)

```json
{
  "type": "serverInfo",
  "data": {
    "version": "0.3.2",
    "supportsAutoLink": true,
    "instanceId": "a3f7c91e-4b2d-4e8a-9c6f-1d2e3f4a5b6c"
  }
}
```

The extension SHALL cache this value in memory (not storage) and use it to
render the Options page.

---

## 6.4 Options Page Behavior

The extension Options page SHALL adapt its UI based on the `supportsAutoLink`
capability and the current connection state.

### State machine

```
┌─────────────────────────────────────────────────────────────────┐
│                        Options Page                              │
│                                                                  │
│  supportsAutoLink == true                                        │
│  ├── connected      → "Connected" indicator + "Re-link" button   │
│  ├── disconnected   → "Disconnected" indicator + "Auto-Link" btn │
│  ├── connecting     → spinner + "Linking..."                     │
│  └── error          → error message + "Retry" button             │
│                                                                  │
│  supportsAutoLink == false                                       │
│  └── standalone     → manual token input field + "Save" button   │
└─────────────────────────────────────────────────────────────────┘
```

### Auto-link available (`supportsAutoLink: true`)

| Connection state | UI elements                                                        |
|------------------|--------------------------------------------------------------------|
| Connected        | Green status indicator, text "Connected to Bridge", "Re-link" button |
| Disconnected     | Grey status indicator, text "Not connected", "Auto-Link" button    |
| Connecting       | Spinner, text "Linking..." (all buttons disabled)                  |
| Error            | Red status indicator, error-specific message (see below), "Retry" button |

### Auto-link unavailable (`supportsAutoLink: false`)

The Options page SHALL render:

1. A text input field labeled "Session Token" for the user to paste the token
   obtained from the Bridge's log output or the MCP Host's UI.
2. A "Save" button that stores the token in `browser.storage.local` and
   attempts a WebSocket connection.
3. An informational note: "Your Bridge is running in Standalone mode. Copy the
   token from your AI client's output and paste it here."

### Error-specific messages

| Error code                    | User-facing message                                         |
|-------------------------------|-------------------------------------------------------------|
| `BRP_BRIDGE_NOT_RUNNING`      | "Start your AI client first, then click Auto-Link."         |
| `BRP_TOKEN_INVALID`           | "Session token expired. Click Re-link to get a new one."    |
| `BRP_IPC_TIMEOUT`             | "Bridge is not responding. Try again in a few seconds."     |
| `BRP_BRIDGE_BUSY`             | "Too many connection attempts. Please wait a moment."       |
| `BRP_BOOTSTRAP_INTERNAL_ERROR`| "An unexpected error occurred. Check the Bridge logs."      |

---

## 6.5 Error Handling

### Bootstrap error flow

When the NM channel delivers a bootstrap error message (Section 5.3), the
extension SHALL:

1. Parse the `error.code` field.
2. Map it to a user-facing message (Section 6.4, error table).
3. If the error is **retryable** (see Section 5.3, retryable column), enter the
   exponential backoff reconnection flow (§7.5).
4. If the error is **non-retryable**, display the diagnostic message and disable
   auto-retry. The user MUST manually trigger a retry from the Options page.

### WebSocket connection refused

When the WebSocket connection is refused (the Bridge has restarted and the
cached port is stale), the extension SHALL:

1. Invalidate the cached token (delete from `browser.storage.local`).
2. Enter the exponential backoff flow (§7.5).
3. After backoff, re-run the bootstrap flow to obtain a fresh token and port.

### WebSocket close 4401 (Unauthorized)

When the Bridge closes the WebSocket with status `4401`:

1. Invalidate the cached token immediately.
2. Re-run the bootstrap flow **without** backoff (the Bridge is running; only
   the token is stale).
3. If the re-bootstrap also fails, fall back to the exponential backoff flow.

### NM port disconnect

If the NM port disconnects unexpectedly (Firefox terminates the bootstrap
process before it writes a response), the extension SHALL treat this as a
`BRP_BOOTSTRAP_INTERNAL_ERROR` and display the corresponding error message.

---

# 7. Crash Recovery & Reconnection

This section defines how the system recovers from process crashes, extension
reloads, and other failure modes. The design principle is: **the Bridge is the
long-lived authority; the extension is a reconnectable client.**

## 7.1 `browserId` Persistence

Each browser profile is assigned a stable identifier (`browserId`) that
persists across extension restarts, browser restarts, and Bridge restarts.

### Generation

The extension SHALL generate a UUID v4 `browserId` on first run (extension
install). The `browserId` is generated once and never regenerated unless the
user explicitly clears extension data.

```javascript
// Extension background script (first run)
const { brp_browser_id } = await browser.storage.local.get("brp_browser_id");
if (!brp_browser_id) {
  const browserId = crypto.randomUUID(); // UUID v4
  await browser.storage.local.set({ brp_browser_id: browserId });
}
```

### Storage location

The `browserId` is stored in `browser.storage.local` under the key
`brp_browser_id`. It is scoped to the browser profile:

- Same profile, different sessions → same `browserId`
- Different profile (e.g., Firefox profile A vs. profile B) → different
  `browserId`
- Profile reset or extension reinstall → new `browserId` generated

### Usage

The `browserId` SHALL be included in:

1. The bootstrap's `request_token` IPC message (Section 5.2, `data.browser_id`).
2. The WebSocket `register` message sent after WS connect.
3. Heartbeat messages (Section 7.3).

This allows the Bridge to:

- Track which browser instances have active sessions.
- Enforce per-browser rate limits (Section 5.6).
- Audit token requests by browser identity.
- Recognize session recovery vs. new registration (Section 7.2).

---

## 7.2 Session Recovery Flow

### Extension reload

When the extension is reloaded (e.g., toggle off/on in `about:addons`, or
auto-update), it SHALL:

1. Read `brp_cached_token`, `brp_ws_port`, and `brp_browser_id` from storage.
2. Attempt WebSocket connection to `ws://127.0.0.1:<brp_ws_port>` with the
   cached token and the same `browserId`.
3. If the WS connects successfully, the Bridge SHALL recognize the `browserId`
   as a **session recovery** — not a new registration. The Bridge SHALL:
   - Restore any per-browser state (e.g., subscribed event channels).
   - Update the `last_seen` timestamp for that `browserId`.
   - Resume normal operation without requiring re-authentication beyond the
     token check.

```
Extension reload sequence:

Extension (reloaded)               Bridge (still running)
    │                                  │
    │ 1. Read cached token + browserId │
    │ 2. WS connect (token + browserId)│
    │──────────────────────────────────>
    │                                  │ 3. Validate token
    │                                  │ 4. Recognize browserId (session recovery)
    │                                  │ 5. Restore per-browser state
    │ 6. WS open confirmed             │
    │<──────────────────────────────────
    │ 7. Begin heartbeat               │
```

### Bridge restart

When the Bridge crashes and is restarted by the MCP Host:

1. The extension's WebSocket connection is severed (TCP RST or close frame).
2. The extension detects the disconnect and enters the exponential backoff flow
   (§7.5).
3. After backoff, the extension re-runs the bootstrap flow to obtain a new
   token (the Bridge generates a new token on restart).
4. The extension connects with the new token and the **same** `browserId`.
5. The Bridge treats this as a **new session** (it has no memory of the previous
   instance). However, the `browserId` allows the MCP Host to correlate the
   session across Bridge restarts for auditing purposes.

```
Bridge restart sequence:

Extension                          Bridge (crashed → restarted)
    │                                  │
    │  WS connection severed           │
    │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
    │                                  │ (MCP Host restarts Bridge)
    │                                  │ New token, new instance_id
    │  Exponential backoff             │
    │  ··· wait 1s ···                 │
    │                                  │
    │  Re-run bootstrap (connectNative)│
    │──────────────────────────────────>
    │  Get new token + ws_port         │
    │<──────────────────────────────────
    │                                  │
    │  WS connect (new token + same browserId)
    │──────────────────────────────────>
    │                                  │ Validate token (new)
    │                                  │ Register browserId (new session)
    │  WS open confirmed               │
    │<──────────────────────────────────
```

---

## 7.3 Heartbeat Mechanism

To detect stale connections and release resources for disconnected browsers,
the extension and Bridge SHALL participate in a heartbeat protocol.

### Extension side

The extension SHALL send a periodic `ping` message over the WebSocket at
**30-second intervals**:

```json
{
  "type": "ping",
  "data": {
    "browserId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "timestamp": "2026-06-27T10:35:30Z"
  }
}
```

The timer SHALL be reset on every outgoing or incoming WebSocket message.
If the WS connection is idle for 30 seconds, the ping is sent. If the WS
is actively exchanging messages, the ping MAY be suppressed (the activity
itself proves liveness).

### Bridge side

The Bridge SHALL maintain a `last_seen` timestamp per registered `browserId`.
This timestamp is updated on:

- Any incoming WebSocket message from the browser.
- Receipt of a `ping` message.

If the Bridge has not received any message from a `browserId` within **90
seconds**, it SHALL:

1. Remove the browser's registration record.
2. Release any resources associated with that browser (event subscriptions,
   pending request queues, rate-limit counters).
3. Close the WebSocket connection with status code `4408` (Heartbeat Timeout).

```json
{
  "type": "close",
  "code": 4408,
  "reason": "Heartbeat timeout: no messages received for 90 seconds"
}
```

### Tunable constants

| Parameter                | Value  | Rationale                                                |
|--------------------------|--------|----------------------------------------------------------|
| Ping interval            | 30s    | Frequent enough to detect disconnects within a minute    |
| Heartbeat timeout        | 90s    | 3× ping interval; tolerates 2 missed pings + jitter      |
| Max clock skew tolerance | ±5s    | For timestamp comparison; not security-critical          |

### Extension disconnect detection

If the extension's WebSocket `onclose` handler fires (for any reason), the
extension SHALL:

1. Stop the heartbeat timer.
2. Enter the reconnection flow (§7.2 or §7.5 depending on the close reason).

---

## 7.4 Pending Request Handling

When the extension disconnects (gracefully or otherwise), the Bridge MUST
fail all pending requests associated with that `browserId`.

### On extension disconnect

The Bridge SHALL iterate over all pending requests for the disconnecting
browser and fail each one with the error code `BRP_EXTENSION_DISCONNECTED`:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32001,
    "message": "Extension disconnected",
    "data": {
      "code": "BRP_EXTENSION_DISCONNECTED",
      "browserId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "pendingCount": 3
    }
  }
}
```

This is reported to the MCP Host via the JSON-RPC error response so that the
AI client can inform the user that their browser extension is no longer
connected.

### On extension reconnect

After reconnection, the pending request queue for the `browserId` SHALL be
empty — all previous requests were already failed in the disconnect handler.
The extension and MCP Host MUST re-issue any requests that were in flight at
the time of disconnection. The Bridge SHALL NOT buffer requests across
disconnect/reconnect boundaries.

---

## 7.5 Exponential Backoff

The extension SHALL use the following backoff schedule when reconnecting after
a WebSocket disconnect or retryable bootstrap error:

```
attempt 1: wait  1s
attempt 2: wait  2s
attempt 3: wait  4s
attempt 4: wait  8s
attempt 5+: wait 30s  (capped)
jitter:     ±500ms    (uniform random)
```

### Algorithm

```javascript
function backoffDelay(attempt) {
  const base = Math.min(Math.pow(2, attempt - 1), 30); // 1, 2, 4, 8, 16→30
  const jitter = (Math.random() - 0.5) * 1000;         // ±500ms
  return Math.max(base * 1000 + jitter, 500);           // floor at 500ms
}
```

### Backoff reset

The attempt counter SHALL reset to 0 upon:

- A successful WebSocket connection.
- User manually clicking "Retry" or "Auto-Link" in the Options page.

### Maximum attempts

The extension SHALL NOT exceed 10 consecutive backoff attempts without user
intervention. After 10 failed attempts, the extension SHALL:

1. Stop automatic reconnection.
2. Display a persistent error in the Options page: "Unable to connect to
   Bridge after multiple attempts. Please verify your AI client is running and
   click Retry."
3. Provide a "Retry" button that resets the counter and begins a fresh attempt.

---

## 7.6 Crash Scenarios Matrix

| Scenario                     | Extension behavior                                            | Bridge behavior                                              |
|------------------------------|---------------------------------------------------------------|--------------------------------------------------------------|
| **Extension reload**         | Re-read cached token + `browserId`; WS reconnect              | Recognize `browserId` as session recovery; restore state     |
| **Extension crash + restart**| Full startup sequence; use cached token if available           | Recognize `browserId`; treat as session recovery if token valid |
| **Bridge crash**             | WS disconnects; exponential backoff; re-bootstrap (new token) | MCP Host restarts Bridge; new token, new `instance_id`       |
| **Both crash**               | Full startup; no valid cache; run bootstrap                   | Full startup; new token, new `instance_id`                   |
| **Browser close**            | Extension stops; WS connection severed                        | Bridge unaffected (MCP Host owns lifecycle); heartbeat timeout cleans up browser record after 90s |
| **Browser reopen**           | Extension starts; cached token + `browserId` available         | Bridge still running; accepts reconnection with existing token |
| **MCP Host crash**           | Extension unaffected if WS stays up; WS severs if Bridge dies | Bridge terminated (child of MCP Host); lockfile cleaned by bootstrap on next scan |
| **Laptop sleep / wake**      | WS may be severed; detect via heartbeat miss or send failure  | Bridge unaffected (long-running); heartbeat timeout may expire; extension reconnects |

### Recovery ordering

When multiple failures occur simultaneously (e.g., Bridge crash during laptop
sleep), the extension SHALL process recovery in this order:

1. Detect WS disconnect (via `onclose` or heartbeat failure).
2. Invalidate cached token.
3. Enter exponential backoff.
4. Re-run bootstrap to obtain a fresh token.
5. Reconnect with same `browserId`.

---

# 8. Multi-Browser Support

BRP targets Firefox and Zen Browser for v0.4.0. This section defines how the
NM manifest coexists across browser variants and how the `browserId` mechanism
supports future multi-browser scenarios.

## 8.1 Firefox + Zen Manifest Coexistence

Firefox and Zen Browser are both Gecko-based and share the Native Messaging
Host discovery mechanism. On most platforms, they read manifests from the same
or closely related directories.

### Manifest directory sharing

| Platform | Firefox path                                                          | Zen path                                                                   | Shared? |
|----------|-----------------------------------------------------------------------|----------------------------------------------------------------------------|---------|
| Linux    | `~/.mozilla/native-messaging-hosts/`                                  | `~/.zen/native-messaging-hosts/` (verify)                                  | Partially — same parent, different subdirectory |
| macOS    | `~/Library/Application Support/Mozilla/NativeMessagingHosts/`         | `~/Library/Application Support/Zen/NativeMessagingHosts/` (verify)         | No — different parent directories |
| Windows  | `HKCU\Software\Mozilla\NativeMessagingHosts\`                         | `HKCU\Software\Zen\NativeMessagingHosts\` (verify)                         | No — different registry keys |

### Implications

- On **Linux**, if both browsers read from `~/.mozilla/native-messaging-hosts/`,
  a single manifest file serves both. If Zen uses `~/.zen/`, the installer
  SHALL write the manifest to both directories.
- On **macOS**, the installer SHALL write the manifest to both the Mozilla and
  Zen directories.
- On **Windows**, the installer SHALL create registry keys under both the
  Mozilla and Zen paths.

### Manifest content

The same manifest file content works for both browsers because the
`allowed_extensions` field lists extension IDs, not browser identifiers:

```json
{
  "name": "org.brp.bridge",
  "description": "BRP Bridge Native Messaging Host",
  "path": "/usr/local/bin/brp-bridge",
  "type": "stdio",
  "allowed_extensions": [
    "brp-extension@yourdomain.com",
    "brp-extension@zen-browser.example"
  ]
}
```

The installer SHALL detect both Firefox and Zen (Section 4.3, browser variant
detection) and install the manifest to all detected locations with the
appropriate `allowed_extensions` list.

### Profile directory verification

Zen Browser MAY use a different profile directory structure than Firefox. The
`brp-bridge --install` command SHALL probe for Zen-specific directories and
log a warning if a known Zen installation is not detected, directing the user
to manual installation documentation.

---

## 8.2 `browserId` in Auto-Link

The `browserId` (Section 7.1) is included in the bootstrap's `request_token`
IPC message. This allows the Bridge to track which browser variant requested
the token.

### Bootstrap request with browser metadata

The bootstrap process SHALL forward the `browser_id` it receives from the
extension's NM stdin input. The extension SHALL write the `browser_id` to
the NM port's stdin before the bootstrap process reads it:

```json
{
  "type": "request_token",
  "data": {
    "browser_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```

### Bridge-side tracking

The Bridge SHALL maintain a registry of `browser_id` values that have
successfully requested tokens:

```json
{
  "f47ac10b-58cc-4372-a567-0e02b2c3d479": {
    "first_seen": "2026-06-27T10:30:00Z",
    "last_seen": "2026-06-27T14:22:15Z",
    "token_requests": 3,
    "active_ws": true
  },
  "c9a1e2b3-4d5f-6789-abcd-ef0123456789": {
    "first_seen": "2026-06-27T11:00:00Z",
    "last_seen": "2026-06-27T11:00:00Z",
    "token_requests": 1,
    "active_ws": false
  }
}
```

This tracking is informational and supports future multi-browser scenarios
(B2 milestone) where each browser MAY receive a distinct token. For v0.4.0,
all browsers share the same session token regardless of `browser_id`.

---

## 8.3 Extension ID Differences

Firefox and Zen Browser MAY assign different extension IDs to the same
extension package, depending on how the extension is distributed (AMO,
self-hosted XPI, Zen's add-on store).

### Manifest `allowed_extensions`

The NM manifest's `allowed_extensions` field MUST list every extension ID
that is permitted to invoke `connectNative`. If the extension is installed in
both Firefox and Zen with different IDs, both IDs MUST appear:

```json
{
  "allowed_extensions": [
    "brp-extension@yourdomain.com",
    "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}"
  ]
}
```

### Installer behavior

The `brp-bridge --install` command SHALL accept an `--extension-id` flag to
add additional extension IDs to the manifest:

```bash
brp-bridge --install --extension-id "brp-extension@yourdomain.com" \
                     --extension-id "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}"
```

If no `--extension-id` is provided, the installer SHALL use the default
extension ID (`brp-extension@yourdomain.com`) and print a warning advising
the user to add additional IDs if using Zen or other browser variants.

### Wildcard approach

Firefox does not support wildcards in `allowed_extensions`. Each extension ID
MUST be listed explicitly. The installer SHALL NOT attempt to use wildcard
patterns.

---

## 8.4 Future Chrome Considerations

Chrome support is **out of scope** for v0.4.0. This section documents known
differences for future reference (targeted at the B2 milestone).

### Manifest differences

| Aspect                  | Firefox / Zen                                     | Chrome / Chromium                                         |
|-------------------------|---------------------------------------------------|-----------------------------------------------------------|
| Auth field              | `allowed_extensions` (extension IDs)              | `allowed_origins` (chrome-extension:// origins)           |
| Manifest path (Linux)   | `~/.mozilla/native-messaging-hosts/`              | `~/.config/google-chrome/NativeMessagingHosts/`           |
| Manifest path (macOS)   | `~/Library/Application Support/Mozilla/...`       | `~/Library/Application Support/Google/Chrome/...`         |
| Manifest path (Windows) | `HKCU\Software\Mozilla\NativeMessagingHosts\`     | `HKCU\Software\Google\Chrome\NativeMessagingHosts\`       |
| Background model        | Event page / persistent background                | MV3 Service Worker (no persistent background)             |

### MV3 Service Worker implications

Chrome's MV3 Service Worker model imposes significant constraints:

1. **No persistent connections.** Service Workers are terminated after ~30s of
   inactivity. The WebSocket connection and heartbeat timer cannot survive
   Service Worker suspension.
2. **No NM port persistence.** The NM port created by `chrome.runtime.connectNative()`
   is bound to the Service Worker's lifetime. When the worker is suspended,
   the port is disconnected.
3. **Workaround required.** A potential approach is to use `chrome.alarms` to
   periodically wake the Service Worker and re-establish the connection, but
   this adds latency and complexity.

### Recommendation

Chrome support SHOULD be deferred until either:

- Chrome relaxes Service Worker lifetime constraints for NM hosts, or
- BRP implements a reconnection model that tolerates frequent Service Worker
  suspension (e.g., message queuing in the Bridge for deferred delivery).

This is tracked as a B2 milestone item and SHALL NOT block v0.4.0 delivery.

---

# Remaining Chapters

All chapters (§1–§8) are now complete. No outstanding sections remain.

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

| Version      | Date       | Changes                                                      |
|--------------|------------|--------------------------------------------------------------|
| 0.3.2        | 2026-07-03 | Added §6 Extension-Side Implementation, §7 Crash Recovery & Reconnection, §8 Multi-Browser Support; all chapters complete |
| 0.3.1-patch  | 2026-07-02 | Added §4 Installation & Distribution, §5 Token Bootstrap Protocol; renumbered future chapters to §6-§8 |
| 0.3.1        | 2026-06-27 | Initial draft: Chapters 1-3, References                      |
