/// BRP Request Router
///
/// Owns BridgeState exclusively. All other modules communicate via channels.
/// Handles protocol lifecycle (initialize/shutdown/exit) locally and forwards
/// all other methods to the connected Firefox extension.
use futures_util::SinkExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, RwLock};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::auth::{ALLOWED_METHODS, MAX_MESSAGE_SIZE};
use crate::protocol::*;
use crate::token_manager::TokenManager;
use crate::ws_server::ExtSender;

// ─── Bridge State ───

/// Central state owned exclusively by the router.
/// Other modules (ws_server) access it through Arc<RwLock<>>.
pub struct BridgeState {
    pub session: Session,
    /// Multiple extension connections: browser_id → sender
    pub extensions: HashMap<String, ExtSender>,
    /// Pending requests: ext_request_id → (client_request_id, oneshot_sender, browser_id)
    pub pending: HashMap<i64, (MessageId, oneshot::Sender<Response>, String)>,
    /// Internal request ID counter for extension communication
    next_ext_id: i64,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            session: Session::new(),
            extensions: HashMap::new(),
            pending: HashMap::new(),
            next_ext_id: 10000,
        }
    }

    pub fn next_ext_request_id(&mut self) -> i64 {
        let id = self.next_ext_id;
        self.next_ext_id += 1;
        id
    }

    pub fn add_extension(&mut self, browser_id: String, sender: ExtSender) {
        log::info!("[Bridge] Extension registered: {}", browser_id);
        self.extensions.insert(browser_id, sender);
    }

    pub fn remove_extension(&mut self, browser_id: &str) {
        log::warn!("[Bridge] Extension disconnected: {}", browser_id);
        self.extensions.remove(browser_id);
    }

    pub fn get_sender<'a>(&'a self, browser_id: Option<&'a str>) -> Option<(&'a str, ExtSender)> {
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

pub async fn handle_request(
    req: Request,
    state: Arc<RwLock<BridgeState>>,
    allow_script_execute: bool,
    token_manager: Arc<TokenManager>,
) -> Response {
    let id = req.id.clone();
    let method = req.method.clone();

    log::info!("[Bridge] → {} (id={})", method, id);

    match method.as_str() {
        // ── B2 Token Management (handled locally, requires master token) ──
        "token.issue" => {
            let requester = req
                .params
                .as_ref()
                .and_then(|p| p.get("masterToken").and_then(|v| v.as_str()))
                .unwrap_or("");
            match token_manager.issue_token(requester).await {
                Ok(new_token) => Response::success(id, json!({"token": new_token})),
                Err(e) => Response::error(
                    id,
                    ErrorResponse {
                        code: -32001,
                        message: e.into(),
                        data: Some(
                            json!({"errorCode": "BRP_MASTER_TOKEN_REQUIRED", "retriable": false}),
                        ),
                    },
                ),
            }
        }
        "token.revoke" => {
            let requester = req
                .params
                .as_ref()
                .and_then(|p| p.get("masterToken").and_then(|v| v.as_str()))
                .unwrap_or("");
            let target = req
                .params
                .as_ref()
                .and_then(|p| p.get("token").and_then(|v| v.as_str()))
                .unwrap_or("");
            match token_manager.revoke_token(requester, target).await {
                Ok(()) => Response::success(id, json!({"revoked": true})),
                Err(e) => Response::error(
                    id,
                    ErrorResponse {
                        code: -32001,
                        message: e.into(),
                        data: Some(
                            json!({"errorCode": if e.contains("Master token") { "BRP_MASTER_TOKEN_REQUIRED" } else { "BRP_TOKEN_REVOKE_FAILED" }, "retriable": false}),
                        ),
                    },
                ),
            }
        }
        "token.list" => {
            let requester = req
                .params
                .as_ref()
                .and_then(|p| p.get("masterToken").and_then(|v| v.as_str()))
                .unwrap_or("");
            match token_manager.list_tokens(requester).await {
                Ok(tokens) => Response::success(id, json!({"tokens": tokens})),
                Err(e) => Response::error(
                    id,
                    ErrorResponse {
                        code: -32001,
                        message: e.into(),
                        data: Some(
                            json!({"errorCode": "BRP_MASTER_TOKEN_REQUIRED", "retriable": false}),
                        ),
                    },
                ),
            }
        }

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
                    session_id: None,
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
                        return Response::error(
                            id,
                            ErrorResponse {
                                code: -32602,
                                message: format!(
                                    "Blocked URL scheme (only http(s) and about:blank allowed): {}",
                                    url
                                ),
                                data: Some(json!({
                                    "errorCode": "BRP_URL_SCHEME_BLOCKED",
                                    "retriable": false
                                })),
                            },
                        );
                    }
                }
            }

            // script.execute gate
            if method == "script.execute" && !allow_script_execute {
                return Response::error(id, ErrorResponse {
                    code: -32602,
                    message:
                        "script.execute is disabled by default. Set BRP_ALLOW_SCRIPT_EXECUTE=1 to enable."
                            .into(),
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

pub async fn forward_to_extension(req: Request, state: Arc<RwLock<BridgeState>>) -> Response {
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
        .send(WsMessage::Text(ext_msg_str.into()))
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
