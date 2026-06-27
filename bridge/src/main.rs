/// BRP Bridge — Main Entry Point
///
/// Architecture:
///   AI Client ←→ stdin/stdout (JSON-RPC 2.0 / Native Messaging) ←→ BRP Bridge ←→ WebSocket Server ←→ Firefox Extension
///
/// The Bridge:
/// 1. Reads JSON-RPC requests from AI Client via stdin
/// 2. Handles protocol lifecycle (initialize / shutdown / exit) locally
/// 3. Forwards all other requests to the Firefox Extension via WebSocket
/// 4. Receives notifications from Extension and forwards to AI Client via stdout
/// 5. Assigns sequence numbers to all outbound notifications (RFC0001 §13)
///
/// Module map (v0.4.0 refactor):
///   config     — environment variables, token generation, file paths
///   auth       — origin validation, JSON limits, method whitelist, token comparison
///   protocol   — JSON-RPC 2.0 message types, session lifecycle
///   ratelimit  — connection rate limiting
///   transport  — native messaging format (stdin/stdout)
///   ws_server  — WebSocket server for extension connections
///
/// Security detail: see SECURITY.md and docs/SECURITY-ARCHITECTURE-DECISIONS.md
mod auth;
mod config;
mod protocol;
mod ratelimit;
mod transport;
mod ws_server;

use auth::*;
use config::BridgeConfig;
use futures_util::SinkExt;
use protocol::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, RwLock};
use ws_server::ExtSender;

// ─── Global State ───

struct BridgeState {
    session: Session,
    /// Multiple extension connections: browser_id → sender
    extensions: HashMap<String, ExtSender>,
    /// Pending requests: ext_request_id → (client_request_id, oneshot_sender, browser_id)
    pending: HashMap<i64, (MessageId, oneshot::Sender<Response>, String)>,
    /// Internal request ID counter for extension communication
    next_ext_id: i64,
}

impl BridgeState {
    fn new() -> Self {
        Self {
            session: Session::new(),
            extensions: HashMap::new(),
            pending: HashMap::new(),
            next_ext_id: 10000,
        }
    }

    fn next_ext_request_id(&mut self) -> i64 {
        let id = self.next_ext_id;
        self.next_ext_id += 1;
        id
    }

    fn add_extension(&mut self, browser_id: String, sender: ExtSender) {
        log::info!("[Bridge] Extension registered: {}", browser_id);
        self.extensions.insert(browser_id, sender);
    }

    fn remove_extension(&mut self, browser_id: &str) {
        log::warn!("[Bridge] Extension disconnected: {}", browser_id);
        self.extensions.remove(browser_id);
    }

    fn get_sender<'a>(&'a self, browser_id: Option<&'a str>) -> Option<(&'a str, ExtSender)> {
        if let Some(id) = browser_id {
            self.extensions.get(id).map(|s| (id, s.clone()))
        } else {
            self.extensions
                .iter()
                .next()
                .map(|(id, s)| (id.as_str(), s.clone()))
        }
    }
}

// ─── Request Handling ───

async fn handle_request(req: Request, state: Arc<RwLock<BridgeState>>, allow_script_execute: bool) -> Response {
    let id = req.id.clone();
    let method = req.method.clone();

    log::info!("[Bridge] → {} (id={})", method, id);

    match method.as_str() {
        // ── Lifecycle: handled locally ──
        "initialize" => {
            let params: InitializeParams = req
                .params
                .as_ref()
                .and_then(|p| serde_json::from_value(p.clone()).ok())
                .unwrap_or(InitializeParams {
                    protocol_version: "0.1.0".into(),
                    client_info: None,
                    capabilities: None,
                });

            let mut s = state.write().await;
            let result = s.session.initialize(&params);
            Response::success(id, serde_json::to_value(result).unwrap())
        }

        "shutdown" => {
            let mut s = state.write().await;
            s.session.shutdown();
            Response::success(id, json!({}))
        }

        "exit" => {
            let mut s = state.write().await;
            s.session.exit();
            Response::success(id, json!({}))
        }

        "browser.list" => {
            let s = state.read().await;
            let browsers: Vec<Value> = s
                .extensions
                .keys()
                .map(|id| json!({ "browserId": id }))
                .collect();
            Response::success(id, json!({ "browsers": browsers, "count": browsers.len() }))
        }

        // ── All other methods: validate and forward to extension ──
        _ => {
            if !ALLOWED_METHODS.contains(&method.as_str()) {
                return Response::error(
                    id,
                    ErrorResponse {
                        code: -32601,
                        message: format!("Unknown method: {}", method),
                        data: Some(json!({
                            "errorCode": error_codes::BRP_METHOD_NOT_FOUND,
                            "retriable": false
                        })),
                    },
                );
            }

            // URL scheme validation
            if method == "page.navigate" || method == "tab.open" {
                if let Some(ref params) = req.params {
                    let url = params
                        .get("url")
                        .or_else(|| params.get("uri"))
                        .and_then(|u| u.as_str())
                        .unwrap_or("");
                    if !url.is_empty()
                        && url != "about:blank"
                        && !url.starts_with("https://")
                        && !url.starts_with("http://")
                    {
                        return Response::error(id, ErrorResponse {
                            code: -32602,
                            message: format!("Blocked URL scheme (only http(s) and about:blank allowed): {}", url),
                            data: Some(json!({
                                "errorCode": "BRP_URL_SCHEME_BLOCKED",
                                "retriable": false
                            })),
                        });
                    }
                }
            }

            // script.execute gate
            if method == "script.execute" && !allow_script_execute {
                return Response::error(id, ErrorResponse {
                    code: -32602,
                    message: "script.execute is disabled by default. Set BRP_ALLOW_SCRIPT_EXECUTE=1 to enable.".into(),
                    data: Some(json!({
                        "errorCode": error_codes::BRP_PERMISSION_DENIED,
                        "retriable": false,
                        "recoveryHint": "Set environment variable BRP_ALLOW_SCRIPT_EXECUTE=1 before starting the Bridge"
                    })),
                });
            }

            // Session state check
            {
                let s = state.read().await;
                if !s.session.is_ready() {
                    return Response::error(
                        id,
                        ErrorResponse {
                            code: -32002,
                            message: "Session not initialized".into(),
                            data: Some(json!({
                                "errorCode": error_codes::BRP_SESSION_UNINITIALIZED,
                                "retriable": false
                            })),
                        },
                    );
                }
            }

            forward_to_extension(req, state).await
        }
    }
}

async fn forward_to_extension(req: Request, state: Arc<RwLock<BridgeState>>) -> Response {
    let target_browser = req
        .params
        .as_ref()
        .and_then(|p| p.get("browserId"))
        .and_then(|b| b.as_str())
        .map(|s| s.to_string());

    let (ext_sender, ext_id, rx, browser_id) = {
        let mut s = state.write().await;

        let (bid, sender) = match s.get_sender(target_browser.as_deref()) {
            Some((id, s)) => (id.to_string(), s),
            None => {
                return Response::error(
                    req.id.clone(),
                    ErrorResponse {
                        code: -32001,
                        message: "No extension connected".into(),
                        data: Some(json!({
                            "errorCode": "BRP_EXTENSION_DISCONNECTED",
                            "retriable": true,
                            "recoveryHint": "Install the BRP extension in Firefox/Zen and ensure it is running"
                        })),
                    },
                );
            }
        };

        let ext_id = s.next_ext_request_id();
        let (tx, rx) = oneshot::channel();
        s.pending.insert(ext_id, (req.id.clone(), tx, bid.clone()));

        (sender, ext_id, rx, bid)
    };

    log::info!(
        "[Bridge] → {} to {} (ext_id={})",
        req.method,
        browser_id,
        ext_id
    );

    let mut params = req.params.unwrap_or(json!({}));
    if let Some(obj) = params.as_object_mut() {
        obj.remove("browserId");
    }

    let ext_msg = json!({
        "jsonrpc": "2.0",
        "id": ext_id,
        "method": req.method,
        "params": params
    });

    let ext_msg_str = ext_msg.to_string();
    if ext_msg_str.len() > MAX_MESSAGE_SIZE {
        let mut s = state.write().await;
        s.pending.remove(&ext_id);
        return Response::error(
            req.id,
            ErrorResponse {
                code: -32000,
                message: "Request too large to forward".into(),
                data: Some(json!({
                    "errorCode": "BRP_MESSAGE_TOO_LARGE",
                    "retriable": false,
                    "size": ext_msg_str.len(),
                    "maxSize": MAX_MESSAGE_SIZE
                })),
            },
        );
    }

    if let Err(e) = ext_sender
        .lock()
        .await
        .send(tokio_tungstenite::tungstenite::Message::Text(ext_msg_str.into()))
        .await
    {
        let mut s = state.write().await;
        s.pending.remove(&ext_id);
        return Response::internal_error(req.id, &format!("Extension send failed: {}", e));
    }

    let client_timeout_ms = params.get("timeout").and_then(|t| t.as_u64()).unwrap_or(0);
    let timeout_secs = std::cmp::max(30, (client_timeout_ms / 1000) + 10);

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => {
            let mut s = state.write().await;
            s.pending.remove(&ext_id);
            Response::internal_error(req.id, "Extension response channel closed")
        }
        Err(_) => {
            let mut s = state.write().await;
            s.pending.remove(&ext_id);
            Response::error(
                req.id,
                ErrorResponse {
                    code: -32000,
                    message: format!("Extension request timed out ({}s)", timeout_secs),
                    data: Some(json!({
                        "errorCode": "BRP_TIMEOUT",
                        "retriable": true
                    })),
                },
            )
        }
    }
}

// ─── Main ───

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("═══ BRP Bridge v{} ═══", env!("CARGO_PKG_VERSION"));

    // Load configuration
    let config = BridgeConfig::load();
    log::info!("[Auth] Token authentication ENABLED (mandatory)");

    let state = Arc::new(RwLock::new(BridgeState::new()));
    let auth_token = Arc::new(config.auth_token.clone());

    // Channels
    let (notify_tx, mut notify_rx) = mpsc::channel::<Value>(64);
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

    // ── Stdin Reader ──
    tokio::task::spawn_blocking(move || {
        log::info!("[Stdin] Listening for AI client requests...");
        loop {
            match transport::read_native_message() {
                Ok(Some(value)) => {
                    let msg_str = value.to_string();
                    if msg_str.len() > MAX_MESSAGE_SIZE {
                        log::warn!(
                            "[Stdin] Message too large ({} bytes), dropping",
                            msg_str.len()
                        );
                        continue;
                    }

                    if !validate_json_depth(&value, MAX_JSON_DEPTH) {
                        log::warn!("[Stdin] Message JSON too deep, dropping");
                        continue;
                    }

                    if let Ok(req) = serde_json::from_value::<Request>(value) {
                        if request_tx.blocking_send(req).is_err() {
                            log::info!("[Stdin] Request channel closed");
                            break;
                        }
                    } else {
                        log::warn!("[Stdin] Unparseable message (not a valid Request)");
                    }
                }
                Ok(None) => {
                    log::info!("[Stdin] EOF — AI client disconnected");
                    break;
                }
                Err(e) => {
                    log::error!("[Stdin] Read error: {}", e);
                    break;
                }
            }
        }
    });

    // ── Stdout Writer ──
    tokio::spawn(async move {
        while let Some(msg) = notify_rx.recv().await {
            if let Err(e) = transport::send_native_message(&msg).await {
                log::error!("[Stdout] Write error: {}", e);
            }
        }
    });

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
        let response = handle_request(req, state.clone(), allow_script_execute).await;

        if let Ok(resp_value) = serde_json::to_value(&response) {
            if let Err(e) = transport::send_native_message(&resp_value).await {
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
