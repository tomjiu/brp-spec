/// BRP JSON-RPC 2.0 Message Types
///
/// Implements the Message Model defined in RFC0001 §9:
/// - Request (client → bridge)
/// - Response (bridge → client)
/// - Notification (bridge → client, no id)
/// - Error Response (bridge → client, with structured error)
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─── JSON-RPC Base ───

#[derive(Debug, Clone)]
pub struct JsonRpcVersion;

impl Default for JsonRpcVersion {
    fn default() -> Self {
        JsonRpcVersion
    }
}

impl Serialize for JsonRpcVersion {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str("2.0")
    }
}

impl<'de> Deserialize<'de> for JsonRpcVersion {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = String::deserialize(d)?;
        if v == "2.0" {
            Ok(JsonRpcVersion)
        } else {
            Err(serde::de::Error::custom("expected \"2.0\""))
        }
    }
}

// ─── Message ID ───

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(untagged)]
pub enum MessageId {
    Number(i64),
    String(String),
}

impl std::fmt::Display for MessageId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MessageId::Number(n) => write!(f, "{}", n),
            MessageId::String(s) => write!(f, "\"{}\"", s),
        }
    }
}

// ─── Request ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub jsonrpc: JsonRpcVersion,
    pub id: MessageId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

// ─── Response ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub jsonrpc: JsonRpcVersion,
    pub id: MessageId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorResponse>,
}

impl Response {
    pub fn success(id: MessageId, result: Value) -> Self {
        Self {
            jsonrpc: JsonRpcVersion,
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: MessageId, error: ErrorResponse) -> Self {
        Self {
            jsonrpc: JsonRpcVersion,
            id,
            result: None,
            error: Some(error),
        }
    }

    pub fn internal_error(id: MessageId, msg: &str) -> Self {
        Self::error(
            id,
            ErrorResponse {
                code: -32603,
                message: msg.to_string(),
                data: Some(serde_json::json!({
                    "errorCode": error_codes::BRP_INTERNAL_ERROR,
                    "retriable": false
                })),
            },
        )
    }
}

// ─── Error Response ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

// ─── Notification ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub jsonrpc: JsonRpcVersion,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl Notification {
    pub fn new(method: &str, params: Value) -> Self {
        Self {
            jsonrpc: JsonRpcVersion,
            method: method.to_string(),
            params: Some(params),
        }
    }
}

// ─── BRP Error Codes (RFC0001 §18) ───

pub mod error_codes {
    pub const BRP_SESSION_UNINITIALIZED: &str = "BRP_SESSION_UNINITIALIZED";
    pub const BRP_PERMISSION_DENIED: &str = "BRP_PERMISSION_DENIED";
    pub const BRP_METHOD_NOT_FOUND: &str = "BRP_METHOD_NOT_FOUND";
    pub const BRP_INTERNAL_ERROR: &str = "BRP_INTERNAL_ERROR";
}
