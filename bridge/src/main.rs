/// BRP Bridge — Main Entry Point
///
/// Architecture:
///   AI Client ←→ stdin/stdout (JSON-RPC 2.0 / Native Messaging) ←→ BRP Bridge ←→ WebSocket Server ←→ Firefox Extension
///
/// The Bridge:
/// 1. Reads JSON-RPC requests from AI Client via stdin
/// 2. Routes requests: lifecycle handled locally, all others forwarded to extension
/// 3. Receives notifications from extension and forwards to AI Client via stdout
///
/// Module map (v0.4.0 refactor):
///   config       — environment variables, token generation, file paths
///   auth         — origin validation, JSON limits, method whitelist, token comparison
///   protocol     — JSON-RPC 2.0 message types, session lifecycle
///   ratelimit    — connection rate limiting
///   transport    — native messaging format (stdin/stdout)
///   ws_server    — WebSocket server for extension connections
///   router       — request routing, owns BridgeState exclusively
///   native_msg   — stdin/stdout I/O loops
///
/// Security detail: see SECURITY.md and docs/SECURITY-ARCHITECTURE-DECISIONS.md
mod auth;
mod config;
#[cfg(unix)]
mod ipc_unix;
#[cfg(windows)]
mod ipc_windows;
mod lockfile;
mod log_sanitizer;
mod mode;
mod native_msg;
mod protocol;
mod ratelimit;
mod router;
mod token_manager;
mod transport;
mod ws_server;

use config::BridgeConfig;
use mode::BridgeMode;
use protocol::{Request, SessionState};
use router::BridgeState;
use serde_json::json;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;
use token_manager::TokenManager;
use tokio::sync::{mpsc, oneshot, RwLock};

#[tokio::main]
async fn main() {
    let mode = mode::parse_mode();

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("═══ BRP Bridge v{} ═══", env!("CARGO_PKG_VERSION"));
    log::info!("[Mode] {:?}", mode);

    match mode {
        BridgeMode::Echo => run_echo().await,
        BridgeMode::Bootstrap => run_bootstrap().await,
        BridgeMode::Bridge => run_bridge().await,
    }
}

// ─── Echo Mode (diagnostic) ───

async fn run_echo() {
    log::info!("[Echo] Diagnostic mode — echoing stdin to stdout in NM format");
    tokio::task::spawn_blocking(|| {
        loop {
            match crate::transport::read_native_message() {
                Ok(Some(value)) => {
                    log::debug!("[Echo] ← {}", value);
                    // Re-encode with NM format (4-byte LE length + JSON)
                    let json_str = value.to_string();
                    let len_bytes = (json_str.len() as u32).to_le_bytes();
                    let mut stdout = std::io::stdout();
                    if let Err(e) = stdout
                        .write_all(&len_bytes)
                        .and_then(|_| stdout.write_all(json_str.as_bytes()))
                        .and_then(|_| stdout.flush())
                    {
                        log::error!("[Echo] Write error: {}", e);
                        break;
                    }
                }
                Ok(None) => {
                    log::info!("[Echo] EOF — exiting");
                    break;
                }
                Err(e) => {
                    log::error!("[Echo] Read error: {}", e);
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
}

// ─── Bootstrap Mode (Firefox connectNative token delivery) ───

async fn run_bootstrap() {
    let config = BridgeConfig::load();

    // ── 1. Acquire IPC lock (single-instance enforcement) ──
    #[cfg(unix)]
    let _ipc_lock = {
        match ipc_unix::acquire_socket_lock().await {
            Ok(lock) => {
                log::info!("[Bootstrap] Unix socket lock acquired");
                Some(lock)
            }
            Err(e) => {
                log::error!("[Bootstrap] Failed to acquire socket lock: {}", e);
                return;
            }
        }
    };

    #[cfg(windows)]
    let _ipc_lock = {
        match ipc_windows::acquire_pipe_lock().await {
            Ok(lock) => {
                log::info!("[Bootstrap] Windows pipe lock acquired");
                Some(lock)
            }
            Err(e) => {
                log::error!("[Bootstrap] Failed to acquire pipe lock: {}", e);
                return;
            }
        }
    };

    // ── 2. Start WebSocket server on port 0 (OS-assigned port) ──
    let state = Arc::new(RwLock::new(BridgeState::new()));
    let token_manager = Arc::new(TokenManager::new(
        config.master_token.clone(),
        config.tokens_file_path.clone(),
        config.auth_token.clone(),
    ));
    log::info!(
        "[Bridge] Master token: {} (use for token.issue/revoke API)",
        config.master_token
    );
    let (notify_tx, _notify_rx) = mpsc::channel::<serde_json::Value>(64);

    // Create oneshot channel before spawning WS server
    // ws_server signals when first extension connects via WebSocket
    let (ws_connected_tx, ws_connected_rx) = oneshot::channel();

    let ws_addr = {
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(e) => {
                log::error!("[Bootstrap] Failed to bind WS port: {}", e);
                return;
            }
        };
        let addr = listener
            .local_addr()
            .expect("bound socket should have addr");
        let ws_port = addr.port();
        log::info!("[Bootstrap] WS server on 127.0.0.1:{}", ws_port);

        // Spawn WS server with the bound listener
        {
            let state = state.clone();
            let notify_tx = notify_tx.clone();
            let token_manager = token_manager.clone();
            let ws_connected_tx = Some(ws_connected_tx);
            tokio::spawn(async move {
                ws_server::run_ws_server_from_listener(
                    listener,
                    token_manager,
                    state,
                    notify_tx,
                    ws_connected_tx,
                )
                .await;
            });
        }

        addr
    };

    // ── 3. Acquire PID lockfile ──
    let lock_data = lockfile::LockData {
        pid: std::process::id(),
        port: ws_addr.port(),
    };
    if let Err(e) = lockfile::acquire(lock_data.clone()) {
        log::error!("[Bootstrap] Failed to acquire lockfile: {}", e);
        return;
    }

    // ── 4. Send token with real port ──
    let token_msg = json!({
        "port": ws_addr.port(),
        "token": config.auth_token
    });

    sanitized_log!(info, "[Bootstrap] Sending token message: {}", token_msg);

    if let Err(e) = crate::transport::send_native_message(&token_msg).await {
        log::error!("[Bootstrap] Failed to send token: {}", e);
        lockfile::release();
        return;
    }

    log::info!("[Bootstrap] Token delivered, waiting for extension WS connection...");

    // ── 5. Wait for WS connection (30s timeout) or Ctrl+C ──
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            log::info!("[Bootstrap] Ctrl+C received (before WS connect)");
            lockfile::release();
            return;
        }
        _ = ws_connected_rx => {
            log::info!("[Bootstrap] Extension connected via WebSocket");
        }
        _ = tokio::time::sleep(Duration::from_secs(30)) => {
            log::warn!("[Bootstrap] WS connection timeout (30s), exiting");
            lockfile::release();
            return;
        }
    }

    // ── 6. WS connected — wait for stdin EOF or Ctrl+C ──
    log::info!("[Bootstrap] WS connected, hanging as keepalive...");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            log::info!("[Bootstrap] Ctrl+C received");
        }
        _ = tokio::task::spawn_blocking(|| {
            let _ = std::io::stdin().read(&mut [0u8]);
        }) => {
            log::info!("[Bootstrap] stdin EOF — Firefox disconnected, exiting");
        }
    }

    lockfile::release();
    log::info!("[Bootstrap] Exiting");
}

// ─── Bridge Mode (full WebSocket + Native Messaging I/O) ───

async fn run_bridge() {
    // ── Acquire IPC lock (prevents B1 from starting a second bridge) ──
    #[cfg(windows)]
    let _ipc_lock = {
        match ipc_windows::acquire_pipe_lock().await {
            Ok(lock) => {
                log::info!("[Bridge] Windows pipe lock acquired (blocks B1 auto-start)");
                Some(lock)
            }
            Err(e) => {
                log::warn!(
                    "[Bridge] Pipe lock not acquired: {} — B1 may start a parallel bridge",
                    e
                );
                None
            }
        }
    };
    #[cfg(unix)]
    let _ipc_lock = {
        match ipc_unix::acquire_socket_lock().await {
            Ok(lock) => {
                log::info!("[Bridge] Unix socket lock acquired (blocks B1 auto-start)");
                Some(lock)
            }
            Err(e) => {
                log::warn!(
                    "[Bridge] Socket lock not acquired: {} — B1 may start a parallel bridge",
                    e
                );
                None
            }
        }
    };

    // ── Configuration ──
    let config = BridgeConfig::load();
    log::info!("[Auth] Token authentication ENABLED (mandatory)");

    let state = Arc::new(RwLock::new(BridgeState::new()));
    let auth_token = Arc::new(config.auth_token.clone());
    let token_manager = Arc::new(TokenManager::new(
        config.master_token.clone(),
        config.tokens_file_path.clone(),
        config.auth_token.clone(),
    ));
    log::info!(
        "[Bridge] Master token: {} (use for token.issue/revoke API)",
        config.master_token
    );

    // ── Channels ──
    let (notify_tx, notify_rx) = mpsc::channel::<serde_json::Value>(64);
    let (request_tx, mut request_rx) = mpsc::channel::<Request>(32);

    // ── WebSocket Server ──
    let use_random_port = config.ws_addr.ends_with(":0");

    if use_random_port {
        let listener = match tokio::net::TcpListener::bind(&config.ws_addr).await {
            Ok(l) => l,
            Err(e) => {
                log::error!("[Bridge] Failed to bind {}: {}", config.ws_addr, e);
                return;
            }
        };
        let addr = listener
            .local_addr()
            .expect("bound socket should have addr");
        let actual_port = addr.port();
        log::info!(
            "[Bridge] WS server on 127.0.0.1:{} (random port)",
            actual_port
        );

        // Write {port, token} to stdout so the MCP adapter / user knows the actual port
        let port_msg = json!({
            "port": actual_port,
            "token": config.auth_token
        });
        if let Err(e) = crate::transport::send_native_message(&port_msg).await {
            log::error!("[Bridge] Failed to write port info: {}", e);
        } else {
            log::info!("[Bridge] Port {} written to stdout", actual_port);
        }

        let state = state.clone();
        let notify_tx = notify_tx.clone();
        let token_manager = token_manager.clone();
        tokio::spawn(async move {
            ws_server::run_ws_server_from_listener(listener, token_manager, state, notify_tx, None)
                .await;
        });
    } else {
        let state = state.clone();
        let notify_tx = notify_tx.clone();
        let ws_addr = config.ws_addr.clone();
        let token_manager = token_manager.clone();
        tokio::spawn(async move {
            ws_server::run_ws_server(&ws_addr, token_manager, state, notify_tx).await;
        });
    }

    // ── Standalone Mode ──
    if config.standalone {
        log::info!("[Bridge] Running in STANDALONE mode (WebSocket only, no stdin)");
        match tokio::signal::ctrl_c().await {
            Ok(_) => log::info!("[Bridge] Ctrl+C received"),
            Err(e) => log::error!("[Bridge] Signal error: {}", e),
        }
        log::info!("BRP Bridge exiting (standalone)");
        return;
    }

    // ── Native Messaging I/O ──
    native_msg::spawn_stdin_reader(request_tx);
    native_msg::spawn_stdout_writer(notify_rx);

    // ── Auth token notification ──
    {
        let token_notification = json!({
            "jsonrpc": "2.0",
            "method": "notification/bridge.authToken",
            "params": {
                "token": auth_token.as_str(),
                "tokenFile": config.token_file_path.to_string_lossy(),
                "message": "Configure this token in the Extension Options page for authentication"
            }
        });
        let _ = notify_tx.send(token_notification).await;
    }

    // ── Main Request Loop ──
    let allow_script_execute = config.allow_script_execute;
    while let Some(req) = request_rx.recv().await {
        let state = state.clone();
        let response = router::handle_request(
            req,
            state.clone(),
            allow_script_execute,
            token_manager.clone(),
        )
        .await;

        if let Ok(resp_value) = serde_json::to_value(&response) {
            if let Err(e) = crate::transport::send_native_message(&resp_value).await {
                log::error!("[Stdout] Response write failed: {}", e);
            }
        }

        let s = state.read().await;
        if s.session.state == SessionState::Closed {
            log::info!("[Bridge] Session closed — goodbye");
            break;
        }
    }
}
