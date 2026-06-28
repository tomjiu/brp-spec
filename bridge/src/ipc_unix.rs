/// Unix Socket IPC — lockfile coordination (Linux/macOS)
///
/// Usage:
///   bootstrap mode: create a UnixListener to claim the socket.
///     If already bound by another bridge, exit. If stale, clean and rebind.
///   bridge mode:  check if socket is occupied via connect().
///     If bootstrap is running → proceed (normal). If stale → clean up.
///
/// Socket path:
///   $XDG_RUNTIME_DIR/brp-bridge.sock  (Linux)
///   /tmp/brp-bridge-<uid>.sock        (fallback, macOS-compatible)
///
/// This module is ONLY compiled on Unix (#[cfg(unix)]).
/// The socket is used for single-instance enforcement — NOT message passing.
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::UnixListener;
use tokio::sync::Mutex;

/// Returns the Unix socket path for BRP bridge coordination.
fn socket_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        PathBuf::from(dir).join("brp-bridge.sock")
    } else {
        // macOS doesn't set XDG_RUNTIME_DIR; use /tmp with UID to avoid collisions
        let uid = unsafe { libc::getuid() };
        PathBuf::from(format!("/tmp/brp-bridge-{}.sock", uid))
    }
}

/// Represents an acquired Unix socket lock.
/// Drops the listener and removes the socket file when released.
pub struct SocketLock {
    path: PathBuf,
    listener: Option<UnixListener>,
}

impl SocketLock {
    /// Try to acquire the socket lock. Returns Ok if we're the sole owner.
    /// Returns Err(already_running) if another bridge holds the lock.
    /// Automatically cleans up stale sockets (process died without cleanup).
    pub async fn acquire() -> std::io::Result<Self> {
        let path = socket_path();
        log::info!("[IPC Unix] Socket path: {}", path.display());

        match UnixListener::bind(&path) {
            Ok(listener) => {
                log::info!("[IPC Unix] Socket acquired successfully");
                Ok(Self {
                    path,
                    listener: Some(listener),
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                log::warn!("[IPC Unix] Socket in use, checking if stale...");
                // Try to connect — if successful, another bridge is alive
                match tokio::net::UnixStream::connect(&path).await {
                    Ok(_) => Err(std::io::Error::new(
                        std::io::ErrorKind::AddrInUse,
                        format!("Bridge already running (socket: {})", path.display()),
                    )),
                    Err(_) => {
                        // Connection refused → stale socket
                        log::warn!(
                            "[IPC Unix] Detected stale socket, cleaning up: {}",
                            path.display()
                        );
                        std::fs::remove_file(&path)?;
                        let listener = UnixListener::bind(&path)?;
                        log::info!("[IPC Unix] Socket re-acquired after stale cleanup");
                        Ok(Self {
                            path,
                            listener: Some(listener),
                        })
                    }
                }
            }
            Err(e) => Err(e),
        }
    }

    /// Release the socket lock and remove the socket file.
    pub fn release(&mut self) {
        if let Some(listener) = self.listener.take() {
            drop(listener);
        }
        if self.path.exists() {
            if let Err(e) = std::fs::remove_file(&self.path) {
                log::error!(
                    "[IPC Unix] Failed to remove socket file {}: {}",
                    self.path.display(),
                    e
                );
            } else {
                log::info!("[IPC Unix] Socket file removed: {}", self.path.display());
            }
        }
    }

    /// Check if a bridge is currently holding the socket (non-destructive).
    /// Used by bridge mode to verify bootstrap is alive before starting WS.
    pub async fn is_bridge_running() -> bool {
        let path = socket_path();
        if !path.exists() {
            return false;
        }
        // Try to connect — if someone accepts, a bridge is alive
        tokio::net::UnixStream::connect(&path).await.is_ok()
    }
}

impl Drop for SocketLock {
    fn drop(&mut self) {
        self.release();
    }
}

/// Wrapper for use in bootstrap mode: acquire socket, return Arc for cleanup.
pub async fn acquire_socket_lock() -> std::io::Result<Arc<Mutex<SocketLock>>> {
    let lock = SocketLock::acquire().await?;
    Ok(Arc::new(Mutex::new(lock)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_socket_path_generation() {
        let path = socket_path();
        let s = path.to_string_lossy();
        assert!(
            s.contains("brp-bridge"),
            "path should contain brp-bridge: {}",
            s
        );
    }

    #[tokio::test]
    async fn test_socket_creation_and_release() {
        let lock = SocketLock::acquire().await;
        assert!(
            lock.is_ok(),
            "first acquire should succeed: {:?}",
            lock.err()
        );

        let mut lock = lock.unwrap();
        assert!(lock.path.exists(), "socket file should exist after acquire");

        lock.release();
        assert!(
            !lock.path.exists(),
            "socket file should be removed after release"
        );
    }

    #[tokio::test]
    async fn test_double_acquire_fails() {
        let lock1 = SocketLock::acquire().await;
        assert!(lock1.is_ok(), "first acquire should succeed");

        let lock2 = SocketLock::acquire().await;
        assert!(lock2.is_err(), "second acquire should fail");
        assert!(
            lock2
                .unwrap_err()
                .to_string()
                .contains("Bridge already running"),
            "error should mention Bridge already running"
        );

        // Cleanup
        drop(lock1);
        // Re-acquire to force cleanup
        let _cleanup = SocketLock::acquire().await;
    }

    #[tokio::test]
    async fn test_is_bridge_running() {
        let lock = SocketLock::acquire().await.unwrap();
        assert!(
            SocketLock::is_bridge_running().await,
            "should detect running bridge"
        );
        drop(lock);
        // Give OS a moment to release
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        assert!(
            !SocketLock::is_bridge_running().await,
            "should not detect bridge after release"
        );
    }
}
