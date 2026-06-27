// b1-ipc-spike: Validate IPC communication for BRP B1 Native Messaging auto-link
//
// Dual-mode binary:
//   --mode=bridge     : Listens on IPC, hands out tokens
//   --mode=bootstrap  : Discovers bridge via lockfiles, requests a token
//
// Platform: Unix Socket (cfg(unix)) or Windows Named Pipe (cfg(windows))

#![allow(dead_code, unused_imports)]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Shared protocol types
// ---------------------------------------------------------------------------

mod protocol {
    use super::*;

    /// Wire message exchanged between bridge and bootstrap over IPC.
    /// Uses adjacently-tagged serde representation per project convention.
    #[derive(Debug, Serialize, Deserialize)]
    #[serde(tag = "type", content = "data")]
    pub enum IpcMessage {
        #[serde(rename = "request_token")]
        RequestToken { browser_id: String },

        #[serde(rename = "token_response")]
        TokenResponse { token: String },
    }

    /// Contents of the per-instance PID lockfile written by bridge mode.
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct LockfileData {
        pub pid: u32,
        pub ipc_path: String,
        pub ws_port: u16,
        pub started_at: String,
        pub instance_id: String,
    }
}

// ---------------------------------------------------------------------------
// Platform-specific IPC: Unix
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod ipc_unix {
    use super::*;
    use tokio::net::{UnixListener, UnixStream};

    pub struct IpcListener {
        listener: UnixListener,
        pub path: PathBuf,
    }

    pub async fn create_listener(instance_id: &str) -> std::io::Result<IpcListener> {
        let path = ipc_path(instance_id);
        // Remove stale socket file if it exists
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path)?;
        Ok(IpcListener { listener, path })
    }

    impl IpcListener {
        pub async fn accept(&self) -> std::io::Result<UnixStream> {
            let (stream, _) = self.listener.accept().await?;
            Ok(stream)
        }
    }

    pub async fn connect(path: &str) -> std::io::Result<UnixStream> {
        UnixStream::connect(path).await
    }

    pub fn ipc_path(instance_id: &str) -> PathBuf {
        PathBuf::from(format!("/tmp/brp-bridge-spike-{}.sock", instance_id))
    }

    /// Unix: verify PID is alive via kill(pid, 0)
    pub fn is_pid_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}

// ---------------------------------------------------------------------------
// Platform-specific IPC: Windows
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod ipc_windows {
    use super::*;
    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeServer, ServerOptions,
    };

    pub struct IpcListener {
        pub server: NamedPipeServer,
        pub pipe_name: String,
    }

    pub async fn create_listener(instance_id: &str) -> std::io::Result<IpcListener> {
        let pipe_name = ipc_path(instance_id);
        let server = ServerOptions::new().create(&pipe_name)?;
        Ok(IpcListener { server, pipe_name })
    }

    impl IpcListener {
        /// Wait for a client to connect, then create a fresh pipe instance
        /// for the next connection.  Returns the connected server handle.
        pub async fn accept(&mut self) -> std::io::Result<NamedPipeServer> {
            // Block until a client connects to the current pipe instance
            self.server.connect().await?;
            // Hand the connected server back to the caller
            let connected = std::mem::replace(
                &mut self.server,
                ServerOptions::new().create(&self.pipe_name)?,
            );
            Ok(connected)
        }
    }

    pub async fn connect(path: &str) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
        ClientOptions::new().open(path)
    }

    pub fn ipc_path(instance_id: &str) -> String {
        format!(r"\\.\pipe\brp-bridge-spike-{}", instance_id)
    }

    /// Windows: check PID liveness via OpenProcess + GetExitCodeProcess.
    /// Uses PROCESS_QUERY_LIMITED_INFORMATION (minimum privilege) to open
    /// the process, then checks whether its exit code is STILL_ACTIVE (259).
    pub fn is_pid_alive(pid: u32) -> bool {
        unsafe {
            let handle = windows_sys::Win32::System::Threading::OpenProcess(
                windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
                0, // don't inherit handle
                pid,
            );

            if handle.is_null()
                || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE
            {
                return false;
            }

            let mut exit_code: u32 = 0;
            let result = windows_sys::Win32::System::Threading::GetExitCodeProcess(
                handle,
                &mut exit_code,
            );

            windows_sys::Win32::Foundation::CloseHandle(handle);

            if result == 0 {
                return false; // GetExitCodeProcess failed
            }

            // STILL_ACTIVE == 259 (not exported by windows-sys 0.59)
            exit_code == 259
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Platform-appropriate directory for PID lockfiles
fn lockfile_dir() -> PathBuf {
    #[cfg(unix)]
    {
        PathBuf::from("/tmp/brp-spike-instances")
    }
    #[cfg(windows)]
    {
        let tmp = std::env::temp_dir();
        tmp.join("brp-spike-instances")
    }
}

fn now_iso8601() -> String {
    // Simplified RFC-3339-ish timestamp — adequate for a spike
    use std::time::SystemTime;
    let d = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("system clock before epoch");
    format!("{}Z", d.as_secs())
}

fn parse_mode_arg() -> String {
    std::env::args()
        .find(|a| a.starts_with("--mode="))
        .map(|a| a.trim_start_matches("--mode=").to_string())
        .unwrap_or_else(|| {
            eprintln!("Usage: b1-ipc-spike --mode=<bridge|bootstrap|stale-test>");
            std::process::exit(1);
        })
}

/// Platform-agnostic PID liveness probe.
fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        ipc_unix::is_pid_alive(pid)
    }
    #[cfg(windows)]
    {
        ipc_windows::is_pid_alive(pid)
    }
}

// ---------------------------------------------------------------------------
// Discovery: scan lockfiles, verify PIDs, clean stale entries
// ---------------------------------------------------------------------------

/// Scan lockfiles, verify PIDs, clean stale entries.
/// Returns list of live candidates sorted by MRU (most recent first).
fn discover_live_instances() -> Vec<protocol::LockfileData> {
    let dir = lockfile_dir();

    if !dir.exists() {
        return Vec::new();
    }

    let mut candidates: Vec<protocol::LockfileData> = Vec::new();

    for entry in std::fs::read_dir(&dir).expect("read lockfile dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let contents = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Discovery: skipping {}: {}", path.display(), e);
                continue;
            }
        };

        let data: protocol::LockfileData = match serde_json::from_str(&contents) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("Discovery: invalid JSON in {}: {}", path.display(), e);
                continue;
            }
        };

        if !is_pid_alive(data.pid) {
            eprintln!("Discovery: stale entry pid={}, cleaning up", data.pid);
            let _ = std::fs::remove_file(&path);
            continue;
        }

        candidates.push(data);
    }

    // Sort MRU first (epoch-seconds string comparison works)
    candidates.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    candidates
}

// ---------------------------------------------------------------------------
// Bridge mode
// ---------------------------------------------------------------------------

async fn run_bridge() {
    let instance_id = Uuid::new_v4().to_string();
    let pid = std::process::id();
    let lockfile_dir = lockfile_dir();

    // --- Create IPC listener (platform-specific) ---
    #[cfg(unix)]
    let mut ipc = {
        let listener = ipc_unix::create_listener(&instance_id)
            .await
            .expect("failed to bind unix socket");
        eprintln!("Bridge mode: listening on {}", listener.path.display());
        listener
    };

    #[cfg(windows)]
    let mut ipc = {
        let listener = ipc_windows::create_listener(&instance_id)
            .await
            .expect("failed to create named pipe");
        eprintln!("Bridge mode: listening on {}", listener.pipe_name);
        listener
    };

    // --- Write PID lockfile ---
    std::fs::create_dir_all(&lockfile_dir).expect("failed to create lockfile dir");

    #[cfg(unix)]
    let ipc_path_str = ipc.path.to_string_lossy().to_string();
    #[cfg(windows)]
    let ipc_path_str = ipc.pipe_name.clone();

    let lockfile_data = protocol::LockfileData {
        pid,
        ipc_path: ipc_path_str.clone(),
        ws_port: 9817,
        started_at: now_iso8601(),
        instance_id: instance_id.clone(),
    };

    let lockfile_path = lockfile_dir.join(format!("{}.json", pid));
    std::fs::write(
        &lockfile_path,
        serde_json::to_string_pretty(&lockfile_data).expect("serialize lockfile"),
    )
    .expect("write lockfile");

    eprintln!("Bridge mode: lockfile written to {}", lockfile_path.display());

    // --- Graceful Ctrl+C handler ---
    let _cleanup_path = ipc_path_str.clone();
    let cleanup_lockfile = lockfile_path.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to listen for ctrl+c");
        eprintln!("\nBridge mode: shutting down, cleaning up...");
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&_cleanup_path);
        }
        let _ = std::fs::remove_file(&cleanup_lockfile);
        eprintln!("Bridge mode: cleanup complete");
        std::process::exit(0);
    });

    // --- Accept loop ---
    loop {
        let mut stream = ipc.accept().await.expect("IPC accept failed");

        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).await.expect("IPC read failed");
            if n == 0 {
                return;
            }

            let msg: Result<protocol::IpcMessage, _> =
                serde_json::from_slice(&buf[..n]);
            match msg {
                Ok(protocol::IpcMessage::RequestToken { browser_id }) => {
                    eprintln!("Bridge mode: request_token browser_id={}", browser_id);
                    // Validate browser_id is a UUID (lenient for spike)
                    if Uuid::parse_str(&browser_id).is_err() {
                        eprintln!(
                            "Bridge mode: warning — browser_id is not a valid UUID: {}",
                            browser_id
                        );
                    }
                    let token = Uuid::new_v4().to_string();
                    let response = protocol::IpcMessage::TokenResponse { token };
                    let json =
                        serde_json::to_vec(&response).expect("serialize response");
                    stream.write_all(&json).await.expect("IPC write failed");
                }
                Ok(other) => {
                    eprintln!("Bridge mode: unexpected message type: {:?}", other);
                }
                Err(e) => {
                    eprintln!("Bridge mode: failed to parse message: {}", e);
                }
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Bootstrap mode
// ---------------------------------------------------------------------------

async fn run_bootstrap() {
    let candidates = discover_live_instances();

    if candidates.is_empty() {
        panic!("No live bridge instances found. Start bridge mode first.");
    }

    let target = &candidates[0];

    eprintln!(
        "Bootstrap mode: connecting to instance {} (pid={})",
        target.instance_id, target.pid
    );

    // --- Connect to IPC endpoint (platform-specific) ---
    #[cfg(unix)]
    let mut stream = ipc_unix::connect(&target.ipc_path)
        .await
        .expect("IPC connect failed");

    #[cfg(windows)]
    let mut stream = ipc_windows::connect(&target.ipc_path)
        .await
        .expect("IPC connect failed");

    // --- Send request_token ---
    let request = protocol::IpcMessage::RequestToken {
        browser_id: "test-browser-id-123".to_string(),
    };
    let json = serde_json::to_vec(&request).expect("serialize request");
    stream.write_all(&json).await.expect("IPC write failed");

    // --- Read response ---
    let mut buf = vec![0u8; 8192];
    let n = stream.read(&mut buf).await.expect("IPC read failed");
    if n == 0 {
        panic!("Connection closed before response");
    }

    let response: protocol::IpcMessage =
        serde_json::from_slice(&buf[..n]).expect("deserialize response");

    let token = match response {
        protocol::IpcMessage::TokenResponse { token } => token,
        other => panic!("Unexpected response: {:?}", other),
    };

    eprintln!("Bootstrap mode: got token = {}", token);

    // --- Write Native Messaging format to stdout ---
    // Format: 4-byte LE length prefix + JSON payload
    let nm_payload = serde_json::json!({ "token": token });
    let nm_json = serde_json::to_vec(&nm_payload).expect("serialize NM payload");
    let len = nm_json.len() as u32;

    let mut stdout = tokio::io::stdout();
    stdout
        .write_all(&len.to_le_bytes())
        .await
        .expect("write NM length prefix");
    stdout
        .write_all(&nm_json)
        .await
        .expect("write NM payload");
    stdout.flush().await.expect("flush stdout");

    eprintln!("Bootstrap mode: Native Messaging output written to stdout ({} bytes)", nm_json.len());
}

// ---------------------------------------------------------------------------
// Stale-test mode: automated stale socket/lockfile cleanup test
// ---------------------------------------------------------------------------

async fn run_stale_test() {
    eprintln!("=== Stale cleanup test: START ===");

    let dir = lockfile_dir();
    std::fs::create_dir_all(&dir).expect("create lockfile dir");

    // Pick a PID that is almost certainly not running.
    // We verify it's actually dead before proceeding.
    let dead_pid: u32 = 99999;
    if is_pid_alive(dead_pid) {
        eprintln!(
            "Stale test: SKIP — PID {} is actually running on this system, cannot test",
            dead_pid
        );
        std::process::exit(2);
    }

    // --- Write a fake lockfile with the known-dead PID ---
    let fake_data = protocol::LockfileData {
        pid: dead_pid,
        #[cfg(unix)]
        ipc_path: "/tmp/brp-bridge-spike-fake.sock".to_string(),
        #[cfg(windows)]
        ipc_path: r"\\.\pipe\brp-bridge-spike-fake".to_string(),
        ws_port: 9817,
        started_at: now_iso8601(),
        instance_id: "fake-instance-for-test".to_string(),
    };

    let fake_path = dir.join(format!("{}.json", dead_pid));
    std::fs::write(
        &fake_path,
        serde_json::to_string_pretty(&fake_data).expect("serialize fake lockfile"),
    )
    .expect("write fake lockfile");

    eprintln!(
        "Stale test: wrote fake lockfile at {} (pid={})",
        fake_path.display(),
        dead_pid
    );

    // --- Run discovery (scan + verify PIDs + clean stale) ---
    let live = discover_live_instances();

    // --- Verify results ---
    let mut pass = true;

    // Check 1: stale lockfile should have been removed
    if fake_path.exists() {
        eprintln!("FAIL: stale lockfile was NOT cleaned up at {}", fake_path.display());
        pass = false;
    } else {
        eprintln!("PASS: stale lockfile cleaned up");
    }

    // Check 2: discovery should report no live instances (unless a real bridge
    // is running, in which case we just verify the fake one was excluded)
    let fake_still_present = live.iter().any(|c| c.pid == dead_pid);
    if fake_still_present {
        eprintln!("FAIL: stale instance still reported as live (pid={})", dead_pid);
        pass = false;
    } else {
        eprintln!("PASS: stale instance excluded from live candidates");
    }

    if live.is_empty() {
        eprintln!("PASS: no live instances found (expected when no bridge is running)");
    } else {
        eprintln!(
            "INFO: {} live instance(s) found (real bridges may be running)",
            live.len()
        );
    }

    // --- Summary ---
    if pass {
        eprintln!("=== Stale cleanup test: ALL CHECKS PASSED ===");
    } else {
        eprintln!("=== Stale cleanup test: FAILED ===");
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let mode = parse_mode_arg();

    match mode.as_str() {
        "bridge" => run_bridge().await,
        "bootstrap" => run_bootstrap().await,
        "stale-test" => run_stale_test().await,
        other => {
            eprintln!(
                "Unknown mode: '{}'. Expected 'bridge', 'bootstrap', or 'stale-test'.",
                other
            );
            std::process::exit(1);
        }
    }
}
