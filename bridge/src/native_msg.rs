/// Native Messaging I/O
///
/// stdin/stdout transport for AI client communication.
/// Uses the Native Messaging format: [4-byte length (native endian u32)] [UTF-8 JSON].
use serde_json::Value;
use tokio::sync::mpsc;

use crate::auth::{validate_json_depth, MAX_JSON_DEPTH, MAX_MESSAGE_SIZE};
use crate::protocol::Request;

/// Spawn a blocking stdin reader that sends parsed JSON-RPC Requests
/// into the request channel. Returns immediately — the reader runs in a
/// background thread.
pub fn spawn_stdin_reader(request_tx: mpsc::Sender<Request>) {
    tokio::task::spawn_blocking(move || {
        log::info!("[Stdin] Listening for AI client requests...");
        loop {
            match crate::transport::read_native_message() {
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
}

/// Spawn an async stdout writer that forwards notifications from the notify
/// channel to the AI client via stdout (Native Messaging format).
pub fn spawn_stdout_writer(mut notify_rx: mpsc::Receiver<Value>) {
    tokio::spawn(async move {
        while let Some(msg) = notify_rx.recv().await {
            if let Err(e) = crate::transport::send_native_message(&msg).await {
                log::error!("[Stdout] Write error: {}", e);
            }
        }
    });
}
