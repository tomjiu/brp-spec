# b1-ipc-spike

Throwaway spike to validate IPC communication for BRP's **B1 Native Messaging
auto-link** feature.  Tests tokio's native IPC APIs across platforms:

| Platform | Transport | API |
|----------|-----------|-----|
| Linux / macOS | Unix domain socket | `tokio::net::UnixListener` / `UnixStream` |
| Windows | Named pipe | `tokio::net::windows::named_pipe::*` |

## Quick start

### Terminal 1 — bridge mode

```bash
cargo run -- --mode=bridge
```

The bridge will:
1. Generate a UUID instance ID
2. Create an IPC listener (unix socket or named pipe)
3. Write a PID lockfile to `/tmp/brp-spike-instances/<pid>.json`
4. Print the IPC path to stderr and wait for connections

### Terminal 2 — bootstrap mode

```bash
cargo run -- --mode=bootstrap
```

The bootstrap will:
1. Scan lockfiles in `/tmp/brp-spike-instances/`
2. Verify PIDs are alive (unix) or skip check (windows)
3. Select the most recently started bridge
4. Connect and send a `request_token` message
5. Print the received token to stderr
6. Write the token in **Native Messaging format** (4-byte LE length + JSON) to stdout

## Platform notes

### Linux / macOS

IPC path: `/tmp/brp-bridge-spike-<uuid>.sock`

PID liveness is verified with `libc::kill(pid, 0)`.

### Windows

IPC path: `\\.\pipe\brp-bridge-spike-<uuid>`

PID liveness check is skipped (always assumed alive) — the connection attempt
itself serves as the liveness probe for this spike.

## What to verify

- [ ] Bridge starts and prints IPC path to stderr
- [ ] Bootstrap connects and receives a UUID token
- [ ] stdout from bootstrap contains valid Native Messaging output:
      4-byte LE length prefix followed by `{"token":"<uuid>"}`
- [ ] Ctrl+C on bridge cleans up socket file and lockfile
- [ ] Stale lockfiles (dead PIDs) are cleaned up by bootstrap

## Wire protocol

Messages use serde's adjacently-tagged enum format:

```json
{"type":"request_token","data":{"browser_id":"<uuid>"}}
{"type":"token_response","data":{"token":"<uuid-v4>"}}
```

Native Messaging stdout format:
```
[4 bytes LE: payload length][JSON: {"token":"<uuid>"}]
```

## Limitations (spike scope)

- Single connection per bootstrap run (no persistent connection)
- No authentication or encryption
- No concurrent client handling on Windows (sequential accept loop)
- Timestamps use epoch-seconds (not full ISO-8601) for simplicity

## Known gaps (production TODO)

These issues are **out of scope for this spike** but must be addressed in the
v0.4.0 production implementation:

1. **Windows Named Pipe ACL:** `ServerOptions::create()` creates pipes that are
   accessible to all users on the machine. Production code must construct a
   `SECURITY_ATTRIBUTES` with a DACL restricting access to the current user's
   SID (via `windows-sys` or `winapi` crate).

2. **Windows PID liveness:** The spike skips PID liveness checks on Windows
   (`is_pid_alive` always returns `true`). Production code must use
   `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, ...)` + `GetExitCodeProcess`
   to verify the bridge process is still running.

3. **Stale socket cleanup testing:** Only the happy path (bridge running →
   bootstrap connects) has been manually verified. The stale cleanup path
   (bridge crashes → lockfile remains → bootstrap detects dead PID → removes
   lockfile and socket) needs an automated test before production use. This
   is especially important on Windows where the PID check is not yet
   implemented.
