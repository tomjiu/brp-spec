/// BRP WebSocket Server
///
/// Accepts connections from Firefox/Zen extensions, performs Origin validation,
/// rate limiting, token authentication, and registration.
/// Forwards extension messages to the bridge and dispatches responses/notifications.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::auth::{
    secure_compare, validate_json_depth, OriginValidator, MAX_JSON_DEPTH, MAX_MESSAGE_SIZE,
};
use crate::protocol::*;
use crate::ratelimit::RateLimiter;
use crate::router::BridgeState;

/// Sender half of the extension WebSocket connection (shared across tasks).
pub type ExtSender = Arc<
    Mutex<
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
            WsMessage,
        >,
    >,
>;

/// Start the WebSocket server that Firefox extensions connect to.
/// Handles rate limiting, origin validation, token auth, and message dispatch.
pub async fn run_ws_server(
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
    run_accept_loop(listener, auth_token, state, notify_tx).await;
}

/// Start the WebSocket server from a pre-bound TcpListener.
/// Used by bootstrap mode which needs the OS-assigned port before starting.
pub async fn run_ws_server_from_listener(
    listener: TcpListener,
    auth_token: Arc<String>,
    state: Arc<RwLock<BridgeState>>,
    notify_tx: mpsc::Sender<Value>,
) {
    let addr = listener
        .local_addr()
        .expect("bound listener should have addr");
    log::info!("[WsServer] Listening on {} for Firefox Extension...", addr);
    run_accept_loop(listener, auth_token, state, notify_tx).await;
}

async fn run_accept_loop(
    listener: TcpListener,
    auth_token: Arc<String>,
    state: Arc<RwLock<BridgeState>>,
    notify_tx: mpsc::Sender<Value>,
) {
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
                    handle_ws_connection(stream, peer, auth_token, state, notify_tx, rate_limiter)
                        .await;
                });
            }
            Err(e) => {
                log::error!("[WsServer] Accept error: {}", e);
            }
        }
    }
}

/// Handle a single WebSocket connection: accept, register, and process messages.
async fn handle_ws_connection(
    stream: tokio::net::TcpStream,
    peer: std::net::SocketAddr,
    auth_token: Arc<String>,
    state: Arc<RwLock<BridgeState>>,
    notify_tx: mpsc::Sender<Value>,
    rate_limiter: Arc<Mutex<RateLimiter>>,
) {
    let ws_result = tokio_tungstenite::accept_hdr_async(stream, OriginValidator).await;

    match ws_result {
        Ok(ws_stream) => {
            let (mut tx, mut receiver) = ws_stream.split();

            // Wait for registration message (10s timeout)
            let browser_id =
                match register_extension(&mut receiver, &mut tx, &auth_token, &rate_limiter, peer)
                    .await
                {
                    Some(id) => id,
                    None => return,
                };

            let ext_sender = Arc::new(Mutex::new(tx));

            // Store the connection
            {
                let mut s = state.write().await;
                s.add_extension(browser_id.clone(), ext_sender);
            }

            // Handle incoming messages from extension
            handle_ext_messages(&browser_id, receiver, state.clone(), notify_tx).await;

            // Extension disconnected — fail all pending requests for this browser
            {
                let mut s = state.write().await;
                s.remove_extension(&browser_id);

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
                                message: "Extension disconnected during request".into(),
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
            log::warn!("[WsServer] Handshake rejected from {}: {}", peer, e);
            rate_limiter.lock().await.on_auth_failed();
        }
    }
}

/// Wait for and validate the extension registration message.
/// Returns the browser_id on success, or None (connection closed) on failure.
async fn register_extension(
    receiver: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    >,
    tx: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        WsMessage,
    >,
    auth_token: &str,
    rate_limiter: &Arc<Mutex<RateLimiter>>,
    peer: std::net::SocketAddr,
) -> Option<String> {
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    let text = match tokio::time::timeout(std::time::Duration::from_secs(10), receiver.next()).await
    {
        Ok(Some(Ok(WsMessage::Text(t)))) => t,
        Ok(Some(Ok(_))) => {
            log::warn!("[WsServer] Non-text first message from {}", peer);
            rate_limiter.lock().await.on_auth_failed();
            return None;
        }
        Ok(Some(Err(_))) | Ok(None) => {
            log::warn!(
                "[WsServer] Connection closed before registration from {}",
                peer
            );
            rate_limiter.lock().await.on_auth_failed();
            return None;
        }
        Err(_) => {
            log::warn!("[WsServer] Registration timeout from {}", peer);
            let _ = tx.send(WsMessage::Close(None)).await;
            rate_limiter.lock().await.on_auth_failed();
            return None;
        }
    };

    // Check message size
    if text.len() > MAX_MESSAGE_SIZE {
        log::warn!("[WsServer] Registration message too large from {}", peer);
        let _ = tx.send(WsMessage::Close(None)).await;
        rate_limiter.lock().await.on_auth_failed();
        return None;
    }

    let v: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            log::warn!("[WsServer] Invalid JSON in registration from {}", peer);
            let _ = tx.send(WsMessage::Close(None)).await;
            rate_limiter.lock().await.on_auth_failed();
            return None;
        }
    };

    // Validate JSON depth
    if !validate_json_depth(&v, MAX_JSON_DEPTH) {
        log::warn!("[WsServer] Registration message too deep from {}", peer);
        let _ = tx.send(WsMessage::Close(None)).await;
        rate_limiter.lock().await.on_auth_failed();
        return None;
    }

    // Must be a register message
    if v.get("method").and_then(|m| m.as_str()) != Some("register") {
        log::warn!("[WsServer] First message is not a register, rejecting");
        let _ = tx.send(WsMessage::Close(None)).await;
        rate_limiter.lock().await.on_auth_failed();
        return None;
    }

    // Token validation
    let provided_token = v
        .get("params")
        .and_then(|p| p.get("token"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    if !secure_compare(provided_token, auth_token) {
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
        rate_limiter.lock().await.on_auth_failed();
        return None;
    }

    let bid = v
        .get("params")
        .and_then(|p| p.get("browserId"))
        .and_then(|b| b.as_str())
        .unwrap_or("unknown")
        .to_string();

    log::info!("[WsServer] Extension authenticated: {} from {}", bid, peer);

    rate_limiter.lock().await.on_authenticated();
    Some(bid)
}

/// Process incoming messages from a connected extension.
/// Dispatches responses to pending requests and forwards notifications.
pub async fn handle_ext_messages(
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
