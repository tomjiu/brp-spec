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
mod native_msg;
mod protocol;
mod ratelimit;
mod router;
mod transport;
mod ws_server;

use config::BridgeConfig;
use protocol::{Request, SessionState};
use router::BridgeState;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("═══ BRP Bridge v{} ═══", env!("CARGO_PKG_VERSION"));

    // ── Configuration ──
    let config = BridgeConfig::load();
    log::info!("[Auth] Token authentication ENABLED (mandatory)");

    let state = Arc::new(RwLock::new(BridgeState::new()));
    let auth_token = Arc::new(config.auth_token.clone());

    // ── Channels ──
    let (notify_tx, notify_rx) = mpsc::channel::<serde_json::Value>(64);
    let (request_tx, mut request_rx) = mpsc::channel::<Request>(32);

    // ── WebSocket Server ──
    {
        let state = state.clone();
        let notify_tx = notify_tx.clone();
        let ws_addr = config.ws_addr.clone();
        let auth_token = auth_token.clone();
        tokio::spawn(async move {
            ws_server::run_ws_server(&ws_addr, auth_token, state, notify_tx).await;
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
        let response = router::handle_request(req, state.clone(), allow_script_execute).await;

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
