#![allow(dead_code)]

/// BRP Session Lifecycle (RFC0001 §10)
///
/// States: Disconnected → Connecting → Authenticating → Ready → Busy → Closing → Closed
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use ts_rs::TS;
use uuid::Uuid;

// ─── Protocol Version Negotiation ───

/// Bridge's maximum supported protocol version.
const BRIDGE_PROTOCOL_VERSION: &str = "0.1.0";

/// Parse a semver string into (major, minor, patch).
/// Returns `None` if the version string is not valid semver.
fn parse_semver(v: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let major = parts[0].parse::<u32>().ok()?;
    let minor = parts[1].parse::<u32>().ok()?;
    let patch = parts[2].parse::<u32>().ok()?;
    Some((major, minor, patch))
}

/// Negotiate the highest mutually-compatible protocol version.
///
/// Semver negotiation rules:
/// - 0.x.y: lower minor version wins (max backward compat within pre-1.0)
/// - 1.x+: same major required; higher patch negotiates to bridge's version
/// - Unparseable versions: fall back to bridge's version
fn negotiate_version(client_version: &str, bridge_version: &str) -> String {
    let client = parse_semver(client_version);
    let bridge = parse_semver(bridge_version);

    match (client, bridge) {
        (Some((0, c_minor, _)), Some((0, b_minor, _))) => {
            // Pre-1.0: both on 0.x.y; negotiate to lower minor for max compat
            let negotiated_minor = c_minor.min(b_minor);
            format!("0.{}.0", negotiated_minor)
        }
        (Some((c_major, _, _)), Some((b_major, _, _))) if c_major == b_major => {
            // Same stable major — use bridge version
            bridge_version.to_string()
        }
        _ => {
            // Incompatible or unparseable — safest fallback
            bridge_version.to_string()
        }
    }
}

// ─── Session State ───

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../bindings/", rename_all = "snake_case")]
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export, export_to = "../bindings/")]
pub struct ClientInfo {
    pub name: String,
    #[serde(default)]
    pub version: String,
}

// ─── Capabilities ───

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export, export_to = "../bindings/")]
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

// ─── Precondition (E3) ───

/// Optional pre-action element validation.
/// When present, the extension validates the target element matches these criteria
/// before executing the action.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export, export_to = "../bindings/")]
pub struct Precondition {
    /// Expected tag name (case-insensitive, e.g. "BUTTON", "A")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_name: Option<String>,
    /// Element text must include this substring
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_contains: Option<String>,
    /// Attribute key-value pairs to match exactly
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attributes: Option<HashMap<String, String>>,
}

// ─── Initialize Params ───

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export, export_to = "../bindings/")]
pub struct InitializeParams {
    #[serde(default = "default_version")]
    pub protocol_version: String,
    #[serde(default)]
    pub client_info: Option<ClientInfo>,
    #[serde(default)]
    pub capabilities: Option<Capabilities>,
}

fn default_version() -> String {
    BRIDGE_PROTOCOL_VERSION.into()
}

// ─── Initialize Result ───

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export, export_to = "../bindings/")]
pub struct InitializeResult {
    pub session_id: String,
    pub protocol_version: String,
    pub negotiated_version: String,
    pub server_info: ServerInfo,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export, export_to = "../bindings/")]
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
}

// ─── Session ───

pub struct Session {
    pub id: String,
    pub state: SessionState,
    pub protocol_version: String,
    pub negotiated_version: String,
    pub client_info: Option<ClientInfo>,
    pub capabilities: Capabilities,
    /// Negotiated action methods (extension ∩ client intersection).
    /// Used by router for O(1) capability enforcement.
    pub negotiated_capabilities: HashSet<String>,
    pub sequence: SequenceCounter,
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
            negotiated_capabilities: HashSet::new(),
            sequence: SequenceCounter::new(),
        }
    }

    /// Handle initialize request (RFC0001 §11)
    pub fn initialize(&mut self, params: &InitializeParams) -> InitializeResult {
        self.state = SessionState::Authenticating;
        self.protocol_version = params.protocol_version.clone();
        self.client_info = params.client_info.clone();

        // Version negotiation: find the highest mutually-compatible protocol version
        let negotiated = negotiate_version(&params.protocol_version, BRIDGE_PROTOCOL_VERSION);
        self.negotiated_version = negotiated.clone();

        // Capability negotiation
        if let Some(ref client_caps) = params.capabilities {
            self.capabilities = self.capabilities.negotiate(client_caps);
        }

        // Populate negotiated_capabilities for O(1) router enforcement
        self.negotiated_capabilities = self
            .capabilities
            .actions
            .iter()
            .filter(|a| {
                // Filter out wildcards — only concrete method names go in the set.
                // Wildcards like "page.*" / "tab.*" are expanded at enforce-time.
                !a.ends_with(".*")
            })
            .cloned()
            .collect();

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_precondition_serde_roundtrip() {
        let pre = Precondition {
            tag_name: Some("BUTTON".into()),
            text_contains: Some("Submit".into()),
            attributes: Some(HashMap::from([("data-testid".into(), "login-btn".into())])),
        };
        let json = serde_json::to_value(&pre).unwrap();
        let pre2: Precondition = serde_json::from_value(json).unwrap();
        assert_eq!(pre2.tag_name.as_deref(), Some("BUTTON"));
        assert_eq!(pre2.text_contains.as_deref(), Some("Submit"));
        let attrs = pre2.attributes.unwrap();
        assert_eq!(attrs.get("data-testid").unwrap(), "login-btn");
    }

    #[test]
    fn test_precondition_optional_fields() {
        let pre = Precondition::default();
        let json = serde_json::to_value(&pre).unwrap();
        assert_eq!(json, serde_json::json!({}));
        let pre2: Precondition = serde_json::from_value(json).unwrap();
        assert!(pre2.tag_name.is_none());
        assert!(pre2.text_contains.is_none());
        assert!(pre2.attributes.is_none());
    }

    // ── Capability Negotiation Tests ──

    #[test]
    fn test_capability_negotiation() {
        let mut session = Session::new();
        let params = InitializeParams {
            protocol_version: "0.1.0".into(),
            client_info: None,
            capabilities: Some(Capabilities {
                actions: vec![
                    "page.navigate".into(),
                    "element.click".into(),
                    "unsupported.method".into(),
                ],
                ..Default::default()
            }),
        };
        let result = session.initialize(&params);
        let actions = &result.capabilities.actions;
        assert!(actions.contains(&"page.navigate".to_string()));
        assert!(actions.contains(&"element.click".to_string()));
        assert!(!actions.contains(&"unsupported.method".to_string()));
        assert!(session.negotiated_capabilities.contains("page.navigate"));
        assert!(!session
            .negotiated_capabilities
            .contains("unsupported.method"));
    }

    #[test]
    fn test_capability_negotiation_empty_client_caps() {
        let mut session = Session::new();
        let params = InitializeParams {
            protocol_version: "0.1.0".into(),
            client_info: None,
            capabilities: Some(Capabilities::default()),
        };
        let result = session.initialize(&params);
        assert_eq!(result.capabilities.actions.len(), 7); // bridge defaults
    }

    // ── Version Negotiation Tests ──

    #[test]
    fn test_negotiate_version_same() {
        let mut session = Session::new();
        let params = InitializeParams {
            protocol_version: "0.1.0".into(),
            client_info: None,
            capabilities: None,
        };
        let result = session.initialize(&params);
        assert!(!result.capabilities.actions.is_empty());
        assert!(!session.negotiated_capabilities.is_empty());
    }

    #[test]
    fn test_wildcards_not_in_negotiated_set() {
        // After initialize (with no client caps → accept all), bridge_default
        // capabilities include wildcards like "page.*" / "tab.*", but
        // negotiated_capabilities should only contain concrete method names.
        let mut session = Session::new();
        let params = InitializeParams {
            protocol_version: "0.1.0".into(),
            client_info: None,
            capabilities: None,
        };
        let result = session.initialize(&params);

        // bridge_default capabilities contain wildcards
        assert!(session
            .capabilities
            .actions
            .iter()
            .any(|a| a.ends_with(".*")));
        // negotiated_capabilities must NOT contain wildcards
        assert!(!session
            .negotiated_capabilities
            .iter()
            .any(|a| a.ends_with(".*")));
        assert_eq!(result.negotiated_version, "0.1.0");
    }

    #[test]
    fn test_negotiate_version_client_newer() {
        // Client sends 0.5.0, bridge supports 0.1.0 → negotiate to bridge's max (0.1.0)
        let mut session = Session::new();
        let params = InitializeParams {
            protocol_version: "0.5.0".into(),
            client_info: None,
            capabilities: None,
        };
        let result = session.initialize(&params);
        assert_eq!(result.negotiated_version, "0.1.0");
    }

    #[test]
    fn test_negotiate_version_both_newer() {
        // Client 0.3.0, bridge 0.1.0 → min(3,1) → 0.1.0
        let mut session = Session::new();
        let params = InitializeParams {
            protocol_version: "0.3.0".into(),
            client_info: None,
            capabilities: None,
        };
        let result = session.initialize(&params);
        assert_eq!(result.negotiated_version, "0.1.0");
    }

    #[test]
    fn test_negotiate_version_client_older() {
        // Client sends 0.0.0, bridge 0.1.0 → negotiate to 0.0.0
        let mut session = Session::new();
        let params = InitializeParams {
            protocol_version: "0.0.0".into(),
            client_info: None,
            capabilities: None,
        };
        let result = session.initialize(&params);
        assert_eq!(result.negotiated_version, "0.0.0");
    }

    #[test]
    fn test_negotiate_version_client_1_x() {
        // Client sends 1.0.0 — same major as bridge default "0.1.0"? No, different major.
        // Falls back to bridge version.
        let mut session = Session::new();
        let params = InitializeParams {
            protocol_version: "1.0.0".into(),
            client_info: None,
            capabilities: None,
        };
        let result = session.initialize(&params);
        assert_eq!(result.negotiated_version, BRIDGE_PROTOCOL_VERSION);
    }

    #[test]
    fn test_negotiate_version_invalid_format() {
        // Unparseable version falls back to bridge version
        let mut session = Session::new();
        let params = InitializeParams {
            protocol_version: "not-a-version".into(),
            client_info: None,
            capabilities: None,
        };
        let result = session.initialize(&params);
        assert_eq!(result.negotiated_version, BRIDGE_PROTOCOL_VERSION);
    }

    #[test]
    fn test_negotiate_version_empty_string() {
        // Empty string → default "0.1.0" from InitializeParams, negotiates to 0.0.0
        let mut session = Session::new();
        let params = InitializeParams {
            protocol_version: "".into(),
            client_info: None,
            capabilities: None,
        };
        let result = session.initialize(&params);
        // Empty string is unparseable → falls back to bridge version
        assert_eq!(result.negotiated_version, BRIDGE_PROTOCOL_VERSION);
    }

    #[test]
    fn test_negotiate_version_same_major_1x() {
        // client 1.2.3, bridge 1.5.0 → same major → returns bridge version
        let result = negotiate_version("1.2.3", "1.5.0");
        assert_eq!(result, "1.5.0");
    }

    #[test]
    fn test_negotiate_version_same_major_2x() {
        let result = negotiate_version("2.0.0", "2.1.1");
        assert_eq!(result, "2.1.1");
    }
}
