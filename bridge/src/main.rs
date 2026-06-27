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
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use futures_util::{SinkExt, StreamExt};

// ─── Types ───

/// Sender half of the extension WebSocket connection
type ExtSender = Arc<Mutex<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    WsMessage,
>>>;

// ─── Global State ───

struct BridgeState {
    session: Session,
    /// Extension WebSocket sender (None = not connected)
    ext_sender: Option<ExtSender>,
    /// Pending requests: ext_request_id → (client_request_id, oneshot_sender)
    pending: HashMap<i64, (MessageId, oneshot::Sender<Response>)>,
    /// Internal request ID counter for extension communication
    next_ext_id: i64,
}

impl BridgeState {
    fn new() -> Self {
        Self {
            session: Session::new(),
            ext_sender: None,
            pending: HashMap::new(),
            next_ext_id: 10000,
        }
    }

    fn next_ext_request_id(&mut self) -> i64 {
        let id = self.next_ext_id;
        self.next_ext_id += 1;
        id
    }
}

// ─── WebSocket Server (Extension connects here) ───

async fn run_ws_server(
    addr: &str,
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
                log::info!("[WsServer] Extension connected from {}", peer);
                let state = state.clone();
                let notify_tx = notify_tx.clone();

                tokio::spawn(async move {
                    match tokio_tungstenite::accept_async(stream).await {
                        Ok(ws_stream) => {
                            let (sender, receiver) = ws_stream.split();

                            // Store the sender in state
                            {
                                let mut s = state.write().await;
                                s.ext_sender = Some(Arc::new(Mutex::new(sender)));
                                log::info!("[WsServer] Extension registered");
                            }

                            // Handle incoming messages from extension
                            handle_ext_messages(receiver, state.clone(), notify_tx).await;

                            // Extension disconnected
                            let mut s = state.write().await;
                            s.ext_sender = None;
                            log::warn!("[WsServer] Extension disconnected");
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
    mut receiver: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    >,
    state: Arc<RwLock<BridgeState>>,
    notify_tx: mpsc::Sender<Value>,
) {
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(WsMessage::Text(text)) => {
                log::debug!("[Ext] ← {}", &text[..text.len().min(300)]);

                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    // Response to a pending request?
                    if let Some(id_num) = value.get("id").and_then(|v| v.as_i64()) {
                        if value.get("result").is_some() || value.get("error").is_some() {
                            // Check if we have a pending request for this ext_id
                            let pending = {
                                let mut s = state.write().await;
                                s.pending.remove(&id_num)
                            };

                            if let Some((client_id, tx)) = pending {
                                // Rewrite the response with the original client ID
                                let mut resp = value.clone();
                                resp["id"] = serde_json::to_value(&client_id).unwrap();
                                if let Ok(response) = serde_json::from_value::<Response>(resp) {
                                    let _ = tx.send(response);
                                }
                            } else {
                                log::debug!("[Ext] No pending request for ext_id={}", id_num);
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
    let (ext_sender, ext_id, rx) = {
        let mut s = state.write().await;

        let sender = match s.ext_sender.clone() {
            Some(s) => s,
            None => {
                return Response::error(req.id.clone(), ErrorResponse {
                    code: -32001,
                    message: "No extension connected".into(),
                    data: Some(json!({
                        "errorCode": "BRP_EXTENSION_DISCONNECTED",
                        "retriable": true,
                        "recoveryHint": "Install the BRP Firefox extension and ensure it is running"
                    })),
                });
            }
        };

        let ext_id = s.next_ext_request_id();
        let (tx, rx) = oneshot::channel();
        s.pending.insert(ext_id, (req.id.clone(), tx));

        (sender, ext_id, rx)
    };

    // Send request to extension
    let ext_msg = json!({
        "jsonrpc": "2.0",
        "id": ext_id,
        "method": req.method,
        "params": req.params.unwrap_or(json!({}))
    });

    if let Err(e) = ext_sender.lock().await.send(WsMessage::Text(ext_msg.to_string().into())).await {
        // Remove pending entry
        let mut s = state.write().await;
        s.pending.remove(&ext_id);
        return Response::internal_error(req.id, &format!("Extension send failed: {}", e));
    }

    // Wait for extension response (with timeout)
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

    // ── Channels ──
    let (notify_tx, mut notify_rx) = mpsc::channel::<Value>(64);
    let (request_tx, mut request_rx) = mpsc::channel::<Request>(32);

    // ── WebSocket Server for Firefox Extension ──
    let ws_addr = std::env::var("BRP_WS_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:9817".into());

    {
        let state = state.clone();
        let notify_tx = notify_tx.clone();
        let ws_addr = ws_addr.clone();
        tokio::spawn(async move {
            run_ws_server(&ws_addr, state, notify_tx).await;
        });
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
