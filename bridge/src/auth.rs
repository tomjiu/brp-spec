/// BRP Bridge — Authentication & Authorization
///
/// Contains origin validation, JSON depth/size limits, constant-time token
/// comparison, the method whitelist, and the script.execute gate.
use serde_json::Value;
use subtle::ConstantTimeEq;

// ─── Constants ───

/// Maximum allowed JSON-RPC message size (bytes).
pub const MAX_MESSAGE_SIZE: usize = 4 * 1024 * 1024; // 4 MB

/// Maximum JSON nesting depth.
pub const MAX_JSON_DEPTH: usize = 32;

/// Maximum number of elements in a JSON array.
pub const MAX_ARRAY_LENGTH: usize = 1024;

/// Maximum number of keys in a JSON object.
pub const MAX_OBJECT_KEYS: usize = 256;

/// Whitelist of JSON-RPC methods that the bridge will forward to the extension.
pub const ALLOWED_METHODS: &[&str] = &[
    "tab.list",
    "tab.open",
    "tab.close",
    "tab.select",
    "page.navigate",
    "page.getInteractionTree",
    "page.screenshot",
    "page.goBack",
    "page.goForward",
    "page.reload",
    "page.waitForSelector",
    "element.click",
    "element.type",
    "element.fill",
    "element.scroll",
    "element.hover",
    "element.select",
    "element.getAttribute",
    "keyboard.press",
    "script.execute",
];

// ─── Origin Validation ───

/// Allowed Origin header values for WebSocket connections.
/// In Native Messaging mode, the extension sends `Origin: null`.
/// In regular mode, it sends `moz-extension://<extension-id>`.
pub fn is_valid_origin(origin: Option<&str>) -> bool {
    match origin {
        // Native Messaging launched extensions send Origin: null
        Some("null") => true,
        // moz-extension:// origins (Firefox extension)
        Some(o) if o.starts_with("moz-extension://") => true,
        // chrome-extension:// origins (for future Chrome support)
        Some(o) if o.starts_with("chrome-extension://") => true,
        // No Origin header — could be a raw TCP client (local process)
        // We allow this because Origin validation defends against *browser* attacks.
        // Local processes are defended by the token/challenge.
        None => true,
        _ => false,
    }
}

// ─── JSON Validation ───

/// Validate JSON depth to prevent stack overflow from deeply nested structures.
pub fn validate_json_depth(value: &Value, max_depth: usize) -> bool {
    if max_depth == 0 {
        return false;
    }
    match value {
        Value::Array(arr) => {
            if arr.len() > MAX_ARRAY_LENGTH {
                return false; // Array length limit
            }
            arr.iter().all(|v| validate_json_depth(v, max_depth - 1))
        }
        Value::Object(obj) => {
            if obj.len() > MAX_OBJECT_KEYS {
                return false; // Object key limit
            }
            obj.values().all(|v| validate_json_depth(v, max_depth - 1))
        }
        _ => true,
    }
}

// ─── Constant-Time Token Comparison ───

/// Compare two strings in constant time to prevent timing attacks.
///
/// **Note:** Early return on length mismatch leaks the token length.
/// This is acceptable because BRP tokens are fixed-length UUID v4 strings
/// (36 characters). An attacker learning the token length provides no
/// practical advantage.
pub fn secure_compare(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

// ─── WebSocket Origin Validator ───

/// Custom WebSocket handshake validator that checks the Origin header.
pub struct OriginValidator;

impl tokio_tungstenite::tungstenite::handshake::server::Callback for OriginValidator {
    fn on_request(
        self,
        request: &tokio_tungstenite::tungstenite::handshake::server::Request,
        response: tokio_tungstenite::tungstenite::handshake::server::Response,
    ) -> Result<
        tokio_tungstenite::tungstenite::handshake::server::Response,
        tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
    > {
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok());

        if !is_valid_origin(origin) {
            log::warn!("[WsServer] REJECTED Origin: {:?}", origin);
            let err = tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(Some(
                "Invalid Origin".to_string(),
            ));
            return Err(err);
        }

        Ok(response)
    }
}

// ─── script.execute Gate ───

/// Returns `true` if the `BRP_ALLOW_SCRIPT_EXECUTE` environment variable is
/// set to `1` or `true` (case-insensitive).
pub fn is_script_execute_allowed() -> bool {
    std::env::var("BRP_ALLOW_SCRIPT_EXECUTE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_secure_compare_equal() {
        assert!(secure_compare("hello", "hello"));
        assert!(secure_compare("", ""));
        assert!(secure_compare(
            "a-long-token-value-12345",
            "a-long-token-value-12345"
        ));
    }

    #[test]
    fn test_secure_compare_different() {
        assert!(!secure_compare("hello", "world"));
        assert!(!secure_compare("aaaaa", "aaaab"));
        // Different lengths — early return (not constant-time, but safe)
        assert!(!secure_compare("short", "a-longer-string"));
        assert!(!secure_compare("", "x"));
    }

    #[test]
    fn test_secure_compare_different_lengths_no_panic() {
        // Different lengths should return false without panicking.
        // This exercises the early-return path (leaks length, acceptable for
        // fixed-length UUID tokens — see doc comment on secure_compare).
        assert!(!secure_compare("short", "much_longer_string_here"));
        assert!(!secure_compare("a-very-long-string-value", "x"));
        assert!(!secure_compare("", "not-empty"));
        assert!(!secure_compare("not-empty", ""));
    }

    #[test]
    fn test_is_valid_origin_moz_extension() {
        assert!(is_valid_origin(Some("moz-extension://abc-123-def")));
        assert!(is_valid_origin(Some("moz-extension://")));
    }

    #[test]
    fn test_is_valid_origin_chrome_extension() {
        assert!(is_valid_origin(Some("chrome-extension://abcdefghijklmnop")));
    }

    #[test]
    fn test_is_valid_origin_null_origin() {
        // Native Messaging mode sends Origin: null
        assert!(is_valid_origin(Some("null")));
    }

    #[test]
    fn test_is_valid_origin_none() {
        // No Origin header — raw TCP client (local process)
        assert!(is_valid_origin(None));
    }

    #[test]
    fn test_is_valid_origin_localhost() {
        // http://localhost is NOT in the allow list — only extension origins
        assert!(!is_valid_origin(Some("http://localhost:3000")));
        assert!(!is_valid_origin(Some("http://localhost")));
    }

    #[test]
    fn test_is_valid_origin_rejects_random() {
        assert!(!is_valid_origin(Some("http://evil.com")));
        assert!(!is_valid_origin(Some("https://example.com")));
        assert!(!is_valid_origin(Some("file:///etc/passwd")));
        assert!(!is_valid_origin(Some("")));
    }

    #[test]
    fn test_validate_json_depth_ok() {
        // Flat value
        assert!(validate_json_depth(&json!("hello"), 32));
        assert!(validate_json_depth(&json!(42), 32));
        assert!(validate_json_depth(&json!(null), 32));
        assert!(validate_json_depth(&json!(true), 32));

        // Simple object
        assert!(validate_json_depth(&json!({"a": 1, "b": 2}), 32));

        // Nested within limits
        let nested = json!({"a": {"b": {"c": {"d": "deep"}}}});
        assert!(validate_json_depth(&nested, 32));
    }

    #[test]
    fn test_validate_json_depth_exceeds_max() {
        // Build a value nested deeper than max_depth
        let mut val = json!("leaf");
        for _ in 0..5 {
            val = json!({ "x": val });
        }
        // 5 levels of nesting should fail with max_depth = 3
        assert!(!validate_json_depth(&val, 3));

        // max_depth = 0 always fails for containers
        assert!(!validate_json_depth(&json!([]), 0));
        assert!(!validate_json_depth(&json!({}), 0));
        // But scalars pass at depth 1 (since depth > 0 and they're leaves)
        assert!(validate_json_depth(&json!(1), 1));
    }

    #[test]
    fn test_validate_json_depth_array_length_limit() {
        // Array at the limit (1024) should pass
        let arr: Vec<Value> = (0..MAX_ARRAY_LENGTH).map(|i| json!(i)).collect();
        assert!(validate_json_depth(&Value::Array(arr), 32));

        // Array over the limit should fail
        let arr: Vec<Value> = (0..MAX_ARRAY_LENGTH + 1).map(|i| json!(i)).collect();
        assert!(!validate_json_depth(&Value::Array(arr), 32));
    }

    #[test]
    fn test_validate_json_depth_object_key_limit() {
        use serde_json::Map;
        // Object at the limit (256 keys) should pass
        let mut obj = Map::new();
        for i in 0..MAX_OBJECT_KEYS {
            obj.insert(format!("k{}", i), json!(i));
        }
        assert!(validate_json_depth(&Value::Object(obj), 32));

        // Object over the limit should fail
        let mut obj = Map::new();
        for i in 0..=MAX_OBJECT_KEYS {
            obj.insert(format!("k{}", i), json!(i));
        }
        assert!(!validate_json_depth(&Value::Object(obj), 32));
    }

    #[test]
    fn test_allowed_methods_contains_core_methods() {
        assert!(ALLOWED_METHODS.contains(&"tab.list"));
        assert!(ALLOWED_METHODS.contains(&"page.navigate"));
        assert!(ALLOWED_METHODS.contains(&"element.click"));
        assert!(ALLOWED_METHODS.contains(&"script.execute"));
    }

    #[test]
    fn test_allowed_methods_rejects_unknown() {
        assert!(!ALLOWED_METHODS.contains(&"browser.execute"));
        assert!(!ALLOWED_METHODS.contains(&""));
    }
}
