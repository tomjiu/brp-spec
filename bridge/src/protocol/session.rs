#![allow(dead_code)]

/// BRP Session Lifecycle (RFC0001 §10)
///
/// States: Disconnected → Connecting → Authenticating → Ready → Busy → Closing → Closed
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

// ─── Session State ───

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Disconnected,
    Connecting,
    Authenticating,
    Ready,
    Busy,
    Closing,
    Closed,
}

impl std::fmt::Display for SessionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disconnected => write!(f, "disconnected"),
            Self::Connecting => write!(f, "connecting"),
            Self::Authenticating => write!(f, "authenticating"),
            Self::Ready => write!(f, "ready"),
            Self::Busy => write!(f, "busy"),
            Self::Closing => write!(f, "closing"),
            Self::Closed => write!(f, "closed"),
        }
    }
}

// ─── Client Info ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    #[serde(default)]
    pub version: String,
}

// ─── Capabilities ───

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Capabilities {
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default)]
    pub tree_delta_supported: bool,
    #[serde(default)]
    pub multi_session: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_request_size: Option<usize>,
}

impl Capabilities {
    /// Bridge's default capabilities
    pub fn bridge_default() -> Self {
        Self {
            features: vec![
                "interactionTree".into(),
                "events".into(),
                "screenshot".into(),
            ],
            actions: vec![
                "page.*".into(),
                "tab.*".into(),
                "element.click".into(),
                "element.type".into(),
                "element.fill".into(),
                "screenshot.capture".into(),
                "script.execute".into(),
            ],
            tree_delta_supported: false,
            multi_session: false,
            max_request_size: Some(10 * 1024 * 1024), // 10MB
        }
    }

    /// Negotiate capabilities: intersection of client and bridge capabilities
    pub fn negotiate(&self, client_caps: &Capabilities) -> Capabilities {
        let features: Vec<String> = client_caps
            .features
            .iter()
            .filter(|f| self.features.contains(f))
            .cloned()
            .collect();

        let actions: Vec<String> = client_caps
            .actions
            .iter()
            .filter(|a| {
                self.actions.iter().any(|ba| {
                    if ba.ends_with(".*") {
                        let prefix = &ba[..ba.len() - 1];
                        a.starts_with(prefix)
                    } else {
                        ba == *a
                    }
                })
            })
            .cloned()
            .collect();

        Capabilities {
            features: if features.is_empty() {
                self.features.clone()
            } else {
                features
            },
            actions: if actions.is_empty() {
                self.actions.clone()
            } else {
                actions
            },
            tree_delta_supported: self.tree_delta_supported && client_caps.tree_delta_supported,
            multi_session: self.multi_session && client_caps.multi_session,
            max_request_size: self.max_request_size,
        }
    }
}

// ─── Initialize Params ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitializeParams {
    #[serde(default = "default_version")]
    pub protocol_version: String,
    #[serde(default)]
    pub client_info: Option<ClientInfo>,
    #[serde(default)]
    pub capabilities: Option<Capabilities>,
}

fn default_version() -> String {
    "0.1.0".into()
}

// ─── Initialize Result ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub session_id: String,
    pub protocol_version: String,
    pub negotiated_version: String,
    pub server_info: ServerInfo,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

// ─── Sequence Counter ───

pub struct SequenceCounter {
    current: u64,
}

impl SequenceCounter {
    pub fn new() -> Self {
        Self { current: 0 }
    }

    pub fn next(&mut self) -> u64 {
        self.current += 1;
        self.current
    }

    pub fn current(&self) -> u64 {
        self.current
    }
}

// ─── Session ───

pub struct Session {
    pub id: String,
    pub state: SessionState,
    pub protocol_version: String,
    pub negotiated_version: String,
    pub client_info: Option<ClientInfo>,
    pub capabilities: Capabilities,
    pub sequence: SequenceCounter,
    pub extra: HashMap<String, Value>,
}

impl Session {
    pub fn new() -> Self {
        Self {
            id: format!("session-{}", &Uuid::new_v4().to_string()[..6]),
            state: SessionState::Disconnected,
            protocol_version: "0.1.0".into(),
            negotiated_version: "0.1.0".into(),
            client_info: None,
            capabilities: Capabilities::bridge_default(),
            sequence: SequenceCounter::new(),
            extra: HashMap::new(),
        }
    }

    /// Handle initialize request (RFC0001 §11)
    pub fn initialize(&mut self, params: &InitializeParams) -> InitializeResult {
        self.state = SessionState::Authenticating;
        self.protocol_version = params.protocol_version.clone();
        self.client_info = params.client_info.clone();

        // Version negotiation: for MVP, accept 0.x.x
        let negotiated = if params.protocol_version.starts_with("0.") {
            "0.1.0".to_string()
        } else {
            self.protocol_version.clone()
        };
        self.negotiated_version = negotiated.clone();

        // Capability negotiation
        if let Some(ref client_caps) = params.capabilities {
            self.capabilities = self.capabilities.negotiate(client_caps);
        }

        self.state = SessionState::Ready;

        InitializeResult {
            session_id: self.id.clone(),
            protocol_version: self.protocol_version.clone(),
            negotiated_version: negotiated,
            server_info: ServerInfo {
                name: "brp-bridge-rust".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: self.capabilities.clone(),
        }
    }

    /// Shutdown sequence (RFC0001 §10.5)
    pub fn shutdown(&mut self) {
        self.state = SessionState::Closing;
    }

    /// Final exit
    pub fn exit(&mut self) {
        self.state = SessionState::Closed;
    }

    /// Check if session accepts requests
    pub fn is_ready(&self) -> bool {
        matches!(self.state, SessionState::Ready | SessionState::Busy)
    }

    /// Get next sequence number for notifications
    pub fn next_sequence(&mut self) -> u64 {
        self.sequence.next()
    }
}
