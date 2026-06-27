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

mod protocol;
mod transport;

use protocol::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use futures_util::{SinkExt, StreamExt};

// ─── Auth Token ───

/// Generate a random auth token and write to a well-known file.
/// Returns the token string.
fn generate_auth_token() -> String {
    let token = uuid::Uuid::new_v4().to_string();
    let path = token_file_path();

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let tmp_path = path.with_extension("tmp");
    if let Err(e) = (|| -> std::io::Result<()> {
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
        log::error!("[Auth] Failed to write token file: {}", e);
    } else {
        log::info!("[Auth] Token written to {}", path.display());
    }

    token
}

/// Cross-platform token file location.
fn token_file_path() -> PathBuf {
    if let Ok(p) = std::env::var("BRP_TOKEN_FILE") {
        return PathBuf::from(p);
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let dir = PathBuf::from(appdata).join("brp-bridge");
            return dir.join("token");
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".brp-bridge-token")
    } else {
        std::env::temp_dir().join("brp-bridge-token")
    }
}

/// Run a minimal HTTP server to serve the auth token.
/// Extension fetches from http://127.0.0.1:<port>/token
async fn run_token_server(addr: &str, token: Arc<String>) {
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("[TokenServer] Failed to bind {}: {}", addr, e);
            return;
        }
    };
    log::info!("[TokenServer] Serving auth token at http://{}", addr);

    loop {
        match listener.accept().await {
            Ok((mut stream, _)) => {
                let token = token.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 1024];
                    let _ = stream.read(&mut buf).await;

                    let response = format!(
                        "HTTP/1.1 200 OK\r\n\
                         Content-Type: text/plain\r\n\
                         Content-Length: {}\r\n\
                         Access-Control-Allow-Origin: *\r\n\
                         Connection: close\r\n\
                         \r\n\
                         {}",
                        token.len(),
                        token
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.flush().await;
                });
            }
            Err(e) => {
                log::error!("[TokenServer] Accept error: {}", e);
            }
        }
    }
}

// ─── Types ───

/// Sender half of the extension WebSocket connection
type ExtSender = Arc<Mutex<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    WsMessage,
>>>;

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
            self.extensions.iter().next().map(|(id, s)| (id.as_str(), s.clone()))
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

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                log::info!("[WsServer] Connection from {}", peer);
                let state = state.clone();
                let notify_tx = notify_tx.clone();
                let auth_token = auth_token.clone();

                tokio::spawn(async move {
                    match tokio_tungstenite::accept_async(stream).await {
                        Ok(ws_stream) => {
                            let (mut tx, mut receiver) = ws_stream.split();
                            let auth_token = auth_token.clone();

                            // Wait for registration message with token auth
                            let browser_id = match receiver.next().await {
                                Some(Ok(WsMessage::Text(text))) => {
                                    match serde_json::from_str::<Value>(&text) {
                                        Ok(v) if v.get("method").and_then(|m| m.as_str()) == Some("register") => {
                                            // Validate auth token
                                            let provided_token = v.get("params")
                                                .and_then(|p| p.get("token"))
                                                .and_then(|t| t.as_str())
                                                .unwrap_or("");

                                            if provided_token != auth_token.as_str() {
                                                log::warn!("[WsServer] AUTH FAILED from {} (token mismatch)", peer);
                                                let err_msg = json!({
                                                    "jsonrpc": "2.0",
                                                    "error": {
                                                        "code": -32001,
                                                        "message": "Authentication failed: invalid token"
                                                    }
                                                });
                                                let _ = tx.send(WsMessage::Text(err_msg.to_string().into())).await;
                                                let _ = tx.send(WsMessage::Close(None)).await;
                                                return;
                                            }

                                            let bid = v.get("params")
                                                .and_then(|p| p.get("browserId"))
                                                .and_then(|b| b.as_str())
                                                .unwrap_or("unknown")
                                                .to_string();
                                            log::info!("[WsServer] Extension authenticated: {} from {}", bid, peer);
                                            bid
                                        }
                                        _ => {
                                            log::warn!("[WsServer] First message is not a register, rejecting");
                                            let _ = tx.send(WsMessage::Close(None)).await;
                                            return;
                                        }
                                    }
                                }
                                _ => {
                                    log::warn!("[WsServer] Connection closed before registration");
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
                            handle_ext_messages(&browser_id, receiver, state.clone(), notify_tx).await;

                            // Extension disconnected
                            let mut s = state.write().await;
                            s.remove_extension(&browser_id);
                        }
                        Err(e) => {
                            log::error!("[WsServer] WebSocket handshake failed: {}", e);
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
                log::debug!("[{}] ← {}", browser_id, &text[..text.len().min(300)]);

                if let Ok(value) = serde_json::from_str::<Value>(&text) {
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
                                log::debug!("[{}] No pending request for ext_id={}", browser_id, id_num);
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
            let params: InitializeParams = req.params
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
            let browsers: Vec<Value> = s.extensions.keys()
                .map(|id| json!({ "browserId": id }))
                .collect();
            Response::success(id, json!({ "browsers": browsers, "count": browsers.len() }))
        }

        // ── All other methods: forward to extension ──

        _ => {
            // Check session state
            {
                let s = state.read().await;
                if !s.session.is_ready() {
                    return Response::error(id, ErrorResponse {
                        code: -32002,
                        message: "Session not initialized".into(),
                        data: Some(json!({
                            "errorCode": error_codes::BRP_SESSION_UNINITIALIZED,
                            "retriable": false
                        })),
                    });
                }
            }

            forward_to_extension(req, state).await
        }
    }
}

async fn forward_to_extension(req: Request, state: Arc<RwLock<BridgeState>>) -> Response {
    // Extract optional browserId from params for routing
    let target_browser = req.params.as_ref()
        .and_then(|p| p.get("browserId"))
        .and_then(|b| b.as_str())
        .map(|s| s.to_string());

    let (ext_sender, ext_id, rx, browser_id) = {
        let mut s = state.write().await;

        let (bid, sender) = match s.get_sender(target_browser.as_deref()) {
            Some((id, s)) => (id.to_string(), s),
            None => {
                return Response::error(req.id.clone(), ErrorResponse {
                    code: -32001,
                    message: "No extension connected".into(),
                    data: Some(json!({
                        "errorCode": "BRP_EXTENSION_DISCONNECTED",
                        "retriable": true,
                        "recoveryHint": "Install the BRP extension in Firefox/Zen and ensure it is running"
                    })),
                });
            }
        };

        let ext_id = s.next_ext_request_id();
        let (tx, rx) = oneshot::channel();
        s.pending.insert(ext_id, (req.id.clone(), tx, bid.clone()));

        (sender, ext_id, rx, bid)
    };

    log::info!("[Bridge] → {} to {} (ext_id={})", req.method, browser_id, ext_id);

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

    if let Err(e) = ext_sender.lock().await.send(WsMessage::Text(ext_msg.to_string().into())).await {
        let mut s = state.write().await;
        s.pending.remove(&ext_id);
        return Response::internal_error(req.id, &format!("Extension send failed: {}", e));
    }

    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => {
            let mut s = state.write().await;
            s.pending.remove(&ext_id);
            Response::internal_error(req.id, "Extension response channel closed")
        }
        Err(_) => {
            let mut s = state.write().await;
            s.pending.remove(&ext_id);
            Response::error(req.id, ErrorResponse {
                code: -32000,
                message: "Extension request timed out (30s)".into(),
                data: Some(json!({
                    "errorCode": "BRP_TIMEOUT",
                    "retriable": true
                })),
            })
        }
    }
}

// ─── Main ───

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .format_timestamp_millis()
    .init();

    log::info!("═══ BRP Bridge v{} ═══", env!("CARGO_PKG_VERSION"));

    let state = Arc::new(RwLock::new(BridgeState::new()));

    // ── Auth Token ──
    let auth_token = Arc::new(generate_auth_token());

    // ── Channels ──
    let (notify_tx, mut notify_rx) = mpsc::channel::<Value>(64);
    let (request_tx, mut request_rx) = mpsc::channel::<Request>(32);

    // ── WebSocket Server for Firefox Extension ──
    let ws_addr = std::env::var("BRP_WS_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:9817".into());

    // Token HTTP server: serve auth token on the port above WS port
    let token_addr = std::env::var("BRP_TOKEN_ADDR")
        .unwrap_or_else(|_| {
            // Default: WS port + 1
            let ws_port: u16 = ws_addr.rsplit(':').next()
                .and_then(|p| p.parse().ok())
                .unwrap_or(9817);
            format!("127.0.0.1:{}", ws_port + 1)
        });

    {
        let auth_token = auth_token.clone();
        tokio::spawn(async move {
            run_token_server(&token_addr, auth_token).await;
        });
    }

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
                    if let Ok(req) = serde_json::from_value::<Request>(value.clone()) {
                        if request_tx.blocking_send(req).is_err() {
                            log::info!("[Stdin] Request channel closed");
                            break;
                        }
                    } else {
                        log::warn!("[Stdin] Unparseable message: {}", value);
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
