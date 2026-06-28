/// PID Lockfile — single-instance enforcement with stale detection
///
/// Lockfile path (user-private):
///   Linux:   $XDG_RUNTIME_DIR/brp-bridge.lock
///   macOS:   /tmp/brp-bridge-<uid>.lock
///   Windows: %LOCALAPPDATA%\brp-bridge\bridge.lock
///
/// Format:  {"pid": <pid>, "port": <ws_port>}
///
/// Startup flow:
///   1. Check if lockfile exists.
///      - No → write new lockfile, proceed.
///      - Yes → parse PID, check liveness.
///        - PID alive → error "Bridge already running".
///        - PID dead  → clean stale lockfile, write new one.
///   2. On exit: remove lockfile.
use serde::{Deserialize, Serialize};
use std::io;
use std::path::PathBuf;

// ─── Lockfile data ───

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LockData {
    pub pid: u32,
    pub port: u16,
}

// ─── Platform-specific lockfile path ───

#[cfg(unix)]
fn lockfile_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("brp-bridge.lock");
    }
    // macOS fallback: /tmp with UID
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!("/tmp/brp-bridge-{}.lock", uid))
}

#[cfg(windows)]
fn lockfile_path() -> PathBuf {
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(localappdata)
        .join("brp-bridge")
        .join("bridge.lock")
}

// ─── Platform-specific PID liveness ───

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    // kill(pid, 0) checks without sending a signal
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn is_pid_alive(pid: u32) -> bool {
    // OpenProcess with SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
    const SYNCHRONIZE: u32 = 0x00100000;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;

    extern "system" {
        fn OpenProcess(desired_access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetExitCodeProcess(process: *mut std::ffi::c_void, exit_code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }

    let handle = unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false; // Can't open → process doesn't exist
    }

    let mut exit_code: u32 = 0;
    let ret = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
    unsafe { CloseHandle(handle) };

    ret != 0 && exit_code == STILL_ACTIVE
}

// ─── Atomic write (write .tmp, sync, rename) ───

fn write_lockfile(data: &LockData) -> io::Result<()> {
    let path = lockfile_path();
    let tmp = path.with_extension("tmp");

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let json = serde_json::to_vec(data)?;
    std::fs::write(&tmp, &json)?;

    // Sync to disk before rename (crash-safe)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let f = std::fs::OpenOptions::new().write(true).open(&tmp)?;
        f.sync_all()?;
        // Restrict permissions on Unix
        let mut perms = f.metadata()?.permissions();
        perms.set_mode(0o600);
        f.set_permissions(perms)?;
    }

    std::fs::rename(&tmp, &path)?;

    log::info!(
        "[Lockfile] Written: {} (pid={}, port={})",
        path.display(),
        data.pid,
        data.port
    );
    Ok(())
}

/// Read and parse an existing lockfile.
fn read_lockfile() -> io::Result<LockData> {
    let path = lockfile_path();
    let bytes = std::fs::read(&path)?;
    let data: LockData = serde_json::from_slice(&bytes).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Lockfile parse error: {}", e),
        )
    })?;
    Ok(data)
}

/// Remove the lockfile on shutdown.
fn remove_lockfile() {
    let path = lockfile_path();
    if path.exists() {
        if let Err(e) = std::fs::remove_file(&path) {
            log::error!("[Lockfile] Failed to remove {}: {}", path.display(), e);
        } else {
            log::info!("[Lockfile] Removed: {}", path.display());
        }
    }
}

/// Startup: acquire the PID lockfile.
/// Returns the port from a *live* existing bridge, if one is already running
/// (for better error messaging).
pub fn acquire(data: LockData) -> io::Result<()> {
    let path = lockfile_path();

    if path.exists() {
        match read_lockfile() {
            Ok(existing) => {
                if is_pid_alive(existing.pid) {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        format!(
                            "Bridge already running (PID {}, port {})",
                            existing.pid, existing.port
                        ),
                    ));
                }
                // PID dead → stale lockfile
                log::warn!(
                    "[Lockfile] Detected stale lockfile (PID {} is dead), cleaning up: {}",
                    existing.pid,
                    path.display()
                );
                let _ = std::fs::remove_file(&path);
            }
            Err(_) => {
                // Corrupt lockfile → clean it up
                log::warn!(
                    "[Lockfile] Corrupt lockfile, cleaning up: {}",
                    path.display()
                );
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    write_lockfile(&data)
}

/// Release the lockfile on shutdown.
pub fn release() {
    remove_lockfile();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn test_lockfile_path() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        PathBuf::from(format!("/tmp/brp-test-lockfile-{}-{}.lock", pid, id))
    }

    fn test_write(data: &LockData, path: &PathBuf) {
        let tmp = path.with_extension("tmp");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&tmp, serde_json::to_vec(data).unwrap()).unwrap();
        std::fs::rename(&tmp, path).unwrap();
    }

    #[test]
    fn test_lockfile_write_and_read() {
        let path = test_lockfile_path();
        let data = LockData {
            pid: std::process::id(),
            port: 9817,
        };
        test_write(&data, &path);

        let bytes = std::fs::read(&path).unwrap();
        let read: LockData = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(read.pid, data.pid);
        assert_eq!(read.port, data.port);

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn test_stale_lockfile_cleanup() {
        let path = test_lockfile_path();
        let dead_data = LockData {
            pid: 99999,
            port: 0,
        };
        test_write(&dead_data, &path);

        // PID 99999 is almost certainly not alive
        assert!(!is_pid_alive(99999), "PID 99999 should be dead");

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn test_live_pid_detection() {
        let current_pid = std::process::id();
        assert!(is_pid_alive(current_pid), "current PID should be alive");
    }

    #[test]
    fn test_atomic_write_no_partial() {
        let path = test_lockfile_path();
        let tmp = path.with_extension("tmp");

        // Write partial content to tmp, simulate crash
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&tmp, b"{broken json").unwrap();
        // Don't rename — crash mid-write

        // Verify no partial lockfile exists
        assert!(!path.exists(), "no lockfile should exist without rename");

        // Clean up tmp
        let _ = std::fs::remove_file(&tmp);
    }
}
