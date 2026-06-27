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
/// TODO(v0.3.2): Further modularization — extract:
///   - `validation.rs`: URL scheme validation, selector length checks, tabId range checks
///   - `config.rs`: environment variable reading and defaults (timeouts, ports, feature gates)
///
/// Security (v0.3.0):
/// - WebSocket Origin validation (rejects non-extension origins)
/// - Server-side connection rate limiting (pre-upgrade)
/// - JSON-RPC message size / depth limits
/// - Optional token auth (Standalone mode: BRP_AUTH_TOKEN env var or extension Options page)
/// - Constant-time credential comparison via `subtle::ConstantTimeEq`
mod auth;
mod protocol;
mod ratelimit;
mod transport;

use auth::*;
use futures_util::{SinkExt, StreamExt};
use protocol::*;
use ratelimit::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio_tungstenite::tungstenite::Message as WsMessage;

// ─── Types ───

/// Sender half of the extension WebSocket connection
type ExtSender = Arc<
    Mutex<
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
            WsMessage,
        >,
    >,
>;

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
            // Return first available extension
            self.extensions
                .iter()
                .next()
                .map(|(id, s)| (id.as_str(), s.clone()))
        }
    }
}

// ─── WebSocket Server (Extension connects here) ───

async fn run_ws_server(
    addr: &str,
    auth_token: Arc<String>,
    state: Arc<RwLock<BridgeState>>,
    notify_tx: mpsc::Sender<Value>,
) {
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("[WsServer] Failed to bind {}: {}", addr, e);
            return;
        }
    };

    log::info!("[WsServer] Listening on {} for Firefox Extension...", addr);
    log::info!("[WsServer] Token authentication ENABLED (mandatory)");

    let rate_limiter = Arc::new(Mutex::new(RateLimiter::new()));

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                // ── Rate limiting (pre-upgrade) ──
                {
                    let mut rl = rate_limiter.lock().await;
                    if let Err(reason) = rl.check_connection() {
                        log::warn!(
                            "[WsServer] Rate limited connection from {}: {}",
                            peer,
                            reason
                        );
                        // Close TCP connection immediately (no WS upgrade)
                        drop(stream);
                        continue;
                    }
                }

                log::info!("[WsServer] Connection from {}", peer);
                let state = state.clone();
                let notify_tx = notify_tx.clone();
                let auth_token = auth_token.clone();
                let rate_limiter = rate_limiter.clone();

                tokio::spawn(async move {
                    // ── Origin validation (before WS upgrade) ──
                    // We use a custom accept callback to check the Origin header
                    let ws_result =
                        tokio_tungstenite::accept_hdr_async(stream, OriginValidator).await;

                    match ws_result {
                        Ok(ws_stream) => {
                            let (mut tx, mut receiver) = ws_stream.split();

                            // Wait for registration message
                            let browser_id = match tokio::time::timeout(
                                std::time::Duration::from_secs(10),
                                receiver.next(),
                            )
                            .await
                            {
                                Ok(Some(Ok(WsMessage::Text(text)))) => {
                                    // Check message size
                                    if text.len() > MAX_MESSAGE_SIZE {
                                        log::warn!(
                                            "[WsServer] Registration message too large from {}",
                                            peer
                                        );
                                        let _ = tx.send(WsMessage::Close(None)).await;
                                        rate_limiter.lock().await.on_auth_failed();
                                        return;
                                    }

                                    match serde_json::from_str::<Value>(&text) {
                                        Ok(v) => {
                                            // Validate JSON depth
                                            if !validate_json_depth(&v, MAX_JSON_DEPTH) {
                                                log::warn!("[WsServer] Registration message too deep from {}", peer);
                                                let _ = tx.send(WsMessage::Close(None)).await;
                                                rate_limiter.lock().await.on_auth_failed();
                                                return;
                                            }

                                            if v.get("method").and_then(|m| m.as_str())
                                                == Some("register")
                                            {
                                                // ── Token validation (always required) ──
                                                let provided_token = v
                                                    .get("params")
                                                    .and_then(|p| p.get("token"))
                                                    .and_then(|t| t.as_str())
                                                    .unwrap_or("");

                                                if !secure_compare(provided_token, &auth_token) {
                                                    log::warn!("[WsServer] AUTH FAILED from {} (token mismatch)", peer);
                                                    let err_msg = json!({
                                                        "jsonrpc": "2.0",
                                                        "error": {
                                                            "code": -32001,
                                                            "message": "Authentication failed: invalid token"
                                                        }
                                                    });
                                                    let _ = tx
                                                        .send(WsMessage::Text(
                                                            err_msg.to_string().into(),
                                                        ))
                                                        .await;
                                                    let _ = tx.send(WsMessage::Close(None)).await;
                                                    rate_limiter.lock().await.on_auth_failed();
                                                    return;
                                                }

                                                let bid = v
                                                    .get("params")
                                                    .and_then(|p| p.get("browserId"))
                                                    .and_then(|b| b.as_str())
                                                    .unwrap_or("unknown")
                                                    .to_string();
                                                log::info!("[WsServer] Extension authenticated: {} from {}", bid, peer);

                                                // Mark as authenticated in rate limiter
                                                rate_limiter.lock().await.on_authenticated();

                                                bid
                                            } else {
                                                log::warn!("[WsServer] First message is not a register, rejecting");
                                                let _ = tx.send(WsMessage::Close(None)).await;
                                                rate_limiter.lock().await.on_auth_failed();
                                                return;
                                            }
                                        }
                                        Err(_) => {
                                            log::warn!(
                                                "[WsServer] Invalid JSON in registration from {}",
                                                peer
                                            );
                                            let _ = tx.send(WsMessage::Close(None)).await;
                                            rate_limiter.lock().await.on_auth_failed();
                                            return;
                                        }
                                    }
                                }
                                Ok(Some(Ok(_))) => {
                                    log::warn!("[WsServer] Non-text first message from {}", peer);
                                    rate_limiter.lock().await.on_auth_failed();
                                    return;
                                }
                                Ok(_) => {
                                    log::warn!(
                                        "[WsServer] Connection closed before registration from {}",
                                        peer
                                    );
                                    rate_limiter.lock().await.on_auth_failed();
                                    return;
                                }
                                Err(_) => {
                                    log::warn!("[WsServer] Registration timeout from {}", peer);
                                    let _ = tx.send(WsMessage::Close(None)).await;
                                    rate_limiter.lock().await.on_auth_failed();
                                    return;
                                }
                            };

                            let ext_sender = Arc::new(Mutex::new(tx));

                            // Store the connection
                            {
                                let mut s = state.write().await;
                                s.add_extension(browser_id.clone(), ext_sender);
                            }

                            // Handle incoming messages from extension
                            handle_ext_messages(&browser_id, receiver, state.clone(), notify_tx)
                                .await;

                            // Extension disconnected — fail all pending requests for this browser
                            {
                                let mut s = state.write().await;
                                s.remove_extension(&browser_id);

                                // Fail all pending requests for this browser immediately
                                let failed_ids: Vec<i64> = s
                                    .pending
                                    .iter()
                                    .filter(|(_, (_, _, bid))| bid == &browser_id)
                                    .map(|(id, _)| *id)
                                    .collect();

                                for ext_id in failed_ids {
                                    if let Some((client_id, tx, _)) = s.pending.remove(&ext_id) {
                                        let err_resp = Response::error(
                                            client_id,
                                            ErrorResponse {
                                                code: -32001,
                                                message: "Extension disconnected during request"
                                                    .into(),
                                                data: Some(json!({
                                                    "errorCode": "BRP_EXTENSION_DISCONNECTED",
                                                    "retriable": true
                                                })),
                                            },
                                        );
                                        let _ = tx.send(err_resp);
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            // Origin validation failed or WS handshake error
                            log::warn!("[WsServer] Handshake rejected from {}: {}", peer, e);
                            rate_limiter.lock().await.on_auth_failed();
                        }
                    }
                });
            }
            Err(e) => {
                log::error!("[WsServer] Accept error: {}", e);
            }
        }
    }
}

async fn handle_ext_messages(
    browser_id: &str,
    mut receiver: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    >,
    state: Arc<RwLock<BridgeState>>,
    notify_tx: mpsc::Sender<Value>,
) {
    let browser_id = browser_id.to_string();

    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(WsMessage::Text(text)) => {
                // ── Message size limit ──
                if text.len() > MAX_MESSAGE_SIZE {
                    log::warn!(
                        "[{}] Message too large ({} bytes), dropping",
                        browser_id,
                        text.len()
                    );
                    continue;
                }

                log::debug!("[{}] ← {}", browser_id, &text[..text.len().min(300)]);

                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    // ── JSON depth validation ──
                    if !validate_json_depth(&value, MAX_JSON_DEPTH) {
                        log::warn!("[{}] Message JSON too deep, dropping", browser_id);
                        continue;
                    }

                    // Response to a pending request?
                    if let Some(id_num) = value.get("id").and_then(|v| v.as_i64()) {
                        if value.get("result").is_some() || value.get("error").is_some() {
                            let pending = {
                                let mut s = state.write().await;
                                s.pending.remove(&id_num)
                            };

                            if let Some((client_id, tx, _bid)) = pending {
                                let mut resp = value.clone();
                                resp["id"] = serde_json::to_value(&client_id).unwrap();
                                // Inject browserId into result
                                if let Some(result) = resp.get_mut("result") {
                                    if let Some(obj) = result.as_object_mut() {
                                        obj.insert("browserId".into(), json!(browser_id));
                                    }
                                }
                                if let Ok(response) = serde_json::from_value::<Response>(resp) {
                                    let _ = tx.send(response);
                                }
                            } else {
                                log::debug!(
                                    "[{}] No pending request for ext_id={}",
                                    browser_id,
                                    id_num
                                );
                            }
                            continue;
                        }
                    }

                    // Notification from extension → forward to AI client with sequence
                    if let Some(method) = value.get("method").and_then(|v| v.as_str()) {
                        let seq = {
                            let mut s = state.write().await;
                            s.session.next_sequence()
                        };

                        let mut params = value.get("params").cloned().unwrap_or(json!({}));
                        params["sequence"] = json!(seq);
                        params["browserId"] = json!(browser_id);

                        let notification = Notification::new(method, params);
                        if let Ok(v) = serde_json::to_value(&notification) {
                            let _ = notify_tx.send(v).await;
                        }
                    }
                }
            }
            Ok(WsMessage::Close(_)) => {
                log::info!("[Ext] Close frame received");
                break;
            }
            Err(e) => {
                log::error!("[Ext] WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }
}

// ─── Request Handling ───

async fn handle_request(req: Request, state: Arc<RwLock<BridgeState>>) -> Response {
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

        // ── All other methods: forward to extension ──
        _ => {
            // ── Method whitelist ──
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

            // ── URL scheme validation (defense in depth — extension also validates) ──
            if method == "page.navigate" || method == "tab.open" {
                if let Some(ref params) = req.params {
                    let url = params
                        .get("url")
                        .or_else(|| params.get("uri"))
                        .and_then(|u| u.as_str())
                        .unwrap_or("");
                    if !url.is_empty() {
                        let is_safe = url == "about:blank" || {
                            url.starts_with("https://") || url.starts_with("http://")
                        };
                        if !is_safe {
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
            }

            // ── script.execute gate (off by default) ──
            if method == "script.execute" && !is_script_execute_allowed() {
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

            // Check session state
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
    // Extract optional browserId from params for routing
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

    // Build params without browserId (it's for routing only, not forwarded)
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

    // ── Outbound message size check ──
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
        .send(WsMessage::Text(ext_msg_str.into()))
        .await
    {
        let mut s = state.write().await;
        s.pending.remove(&ext_id);
        return Response::internal_error(req.id, &format!("Extension send failed: {}", e));
    }

    // ── Dynamic forwarding timeout ──
    // Use client-specified timeout + buffer, with a minimum of 30s.
    // This fixes the conflict between the 30s Bridge timeout and 60s waitForSelector cap.
    let client_timeout_ms = params.get("timeout").and_then(|t| t.as_u64()).unwrap_or(0);
    let timeout_secs = std::cmp::max(
        30,
        (client_timeout_ms / 1000) + 10, // client timeout + 10s buffer
    );

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

    let state = Arc::new(RwLock::new(BridgeState::new()));

    // ── Auth Token (always generated, always required) ──
    // The Bridge always generates a random token at startup.
    // If BRP_AUTH_TOKEN is set, use that instead (user override).
    // Token is written to a file (0600) and sent to the adapter via stdout.
    // This defends against local process attacks (the second column of the threat model).
    let auth_token: Arc<String> = Arc::new(
        std::env::var("BRP_AUTH_TOKEN")
            .ok()
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| {
                let token = uuid::Uuid::new_v4().to_string();
                // Write token to file with restricted permissions
                let path = token_file_path();
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let tmp_path = path.with_extension("tmp");
                if let Err(e) = (|| -> std::io::Result<()> {
                    use std::io::Write;
                    let mut f = std::fs::File::create(&tmp_path)?;
                    f.write_all(token.as_bytes())?;
                    f.sync_all()?;
                    std::fs::rename(&tmp_path, &path)?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
                    }
                    Ok(())
                })() {
                    log::warn!("[Auth] Failed to write token file: {}", e);
                } else {
                    log::info!("[Auth] Token written to {}", path.display());
                }
                log::info!("[Auth] Auto-generated token: configure in Extension Options page");
                token
            }),
    );

    log::info!("[Auth] Token authentication ENABLED (mandatory)");

    // Cross-platform token file location.
    fn token_file_path() -> std::path::PathBuf {
        if let Ok(p) = std::env::var("BRP_TOKEN_FILE") {
            return std::path::PathBuf::from(p);
        }
        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                return std::path::PathBuf::from(appdata)
                    .join("brp-bridge")
                    .join("token");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            std::path::PathBuf::from(home).join(".brp-bridge-token")
        } else {
            std::env::temp_dir().join("brp-bridge-token")
        }
    }

    // ── Channels ──
    let (notify_tx, mut notify_rx) = mpsc::channel::<Value>(64);
    let (request_tx, mut request_rx) = mpsc::channel::<Request>(32);

    // ── WebSocket Server for Firefox Extension ──
    let ws_addr = std::env::var("BRP_WS_ADDR").unwrap_or_else(|_| "127.0.0.1:9817".into());

    {
        let state = state.clone();
        let notify_tx = notify_tx.clone();
        let ws_addr = ws_addr.clone();
        let auth_token = auth_token.clone();
        tokio::spawn(async move {
            run_ws_server(&ws_addr, auth_token, state, notify_tx).await;
        });
    }

    // ── Standalone Mode ──
    // When BRP_STANDALONE=1, Bridge runs as pure WS server (no stdin/stdout needed).
    // The MCP adapter connects via WebSocket directly.
    let standalone = std::env::var("BRP_STANDALONE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if standalone {
        log::info!("[Bridge] Running in STANDALONE mode (WebSocket only, no stdin)");

        // Just keep the WS server alive until Ctrl+C
        match tokio::signal::ctrl_c().await {
            Ok(_) => log::info!("[Bridge] Ctrl+C received"),
            Err(e) => log::error!("[Bridge] Signal error: {}", e),
        }
        log::info!("BRP Bridge exiting (standalone)");
        return;
    }

    // ── Stdin Reader (AI Client → Bridge) ──
    tokio::task::spawn_blocking(move || {
        log::info!("[Stdin] Listening for AI client requests...");
        loop {
            match transport::read_native_message() {
                Ok(Some(value)) => {
                    // ── Inbound message size check ──
                    let msg_str = value.to_string();
                    if msg_str.len() > MAX_MESSAGE_SIZE {
                        log::warn!(
                            "[Stdin] Message too large ({} bytes), dropping",
                            msg_str.len()
                        );
                        continue;
                    }

                    // ── JSON depth validation ──
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

    // ── Stdout Writer (notifications → AI Client) ──
    tokio::spawn(async move {
        while let Some(msg) = notify_rx.recv().await {
            if let Err(e) = transport::send_native_message(&msg).await {
                log::error!("[Stdout] Write error: {}", e);
            }
        }
    });

    // ── Send auth token to adapter via stdout ──
    // The MCP adapter reads this notification and can relay the token.
    // Token file path is included so the adapter can verify or display it.
    {
        let token_notification = json!({
            "jsonrpc": "2.0",
            "method": "notification/bridge.authToken",
            "params": {
                "token": auth_token.as_str(),
                "tokenFile": token_file_path().to_string_lossy(),
                "message": "Configure this token in the Extension Options page for authentication"
            }
        });
        let _ = notify_tx.send(token_notification).await;
    }

    // ── Main Request Loop ──
    while let Some(req) = request_rx.recv().await {
        let state = state.clone();
        let response = handle_request(req, state.clone()).await;

        // Send response to AI client via stdout
        if let Ok(resp_value) = serde_json::to_value(&response) {
            if let Err(e) = transport::send_native_message(&resp_value).await {
                log::error!("[Stdout] Response write failed: {}", e);
            }
        }

        // Exit if session closed
        let s = state.read().await;
        if s.session.state == SessionState::Closed {
            log::info!("[Bridge] Session closed — goodbye");
            break;
        }
    }
}
