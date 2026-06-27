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
2. Verify PIDs are alive (unix: `kill(pid, 0)`, windows: `OpenProcess` + `GetExitCodeProcess`)
3. Clean up stale lockfiles (dead PIDs) automatically
4. Select the most recently started bridge
5. Connect and send a `request_token` message
6. Print the received token to stderr
7. Write the token in **Native Messaging format** (4-byte LE length + JSON) to stdout

### Stale cleanup test

```bash
cargo run -- --mode=stale-test
```

Automated test that verifies stale lockfile cleanup works correctly:
1. Creates a fake lockfile with a known-dead PID (99999)
2. Runs the discovery logic (scan lockfiles, verify PIDs, clean stale entries)
3. Verifies the stale lockfile was deleted
4. Verifies the dead PID is excluded from live candidates
5. Prints PASS/FAIL results to stderr (exit code 0 on pass, 1 on fail)

## Platform notes

### Linux / macOS

IPC path: `/tmp/brp-bridge-spike-<uuid>.sock`

PID liveness is verified with `libc::kill(pid, 0)`.

### Windows

IPC path: `\\.\pipe\brp-bridge-spike-<uuid>`

PID liveness is verified via `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` +
`GetExitCodeProcess` (checking for `STILL_ACTIVE`). This uses the `windows-sys`
crate with minimal privileges.

## What to verify

- [ ] Bridge starts and prints IPC path to stderr
- [ ] Bootstrap connects and receives a UUID token
- [ ] stdout from bootstrap contains valid Native Messaging output:
      4-byte LE length prefix followed by `{"token":"<uuid>"}`
- [ ] Ctrl+C on bridge cleans up socket file and lockfile
- [ ] Stale lockfiles (dead PIDs) are cleaned up by bootstrap
- [ ] `--mode=stale-test` passes all checks (lockfile cleanup + PID exclusion)

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
