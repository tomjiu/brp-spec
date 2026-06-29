//! BRP Log Sanitizer
//!
//! Redacts sensitive patterns from log messages.

use std::sync::LazyLock;
use regex::Regex;

static SENSITIVE_PATTERNS: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
    vec![
        (Regex::new(r###"(?i)(token\s*[=:]\s*)[^\s&"',}]+"###).unwrap(), "${1}***"),
        (Regex::new(r###"(?i)(password\s*[=:]\s*)[^\s&"',}]+"###).unwrap(), "${1}***"),
        (Regex::new(r###"(?i)(authorization\s*:\s*bearer\s+)[^\s"',}]+"###).unwrap(), "${1}***"),
        (Regex::new(r#"(?i)"((?:auth_?token|secret|api_?key))"\s*:\s*"[^"]*""#).unwrap(), r#""$1": "***""#),
    ]
});

pub fn sanitize(input: &str) -> String {
    let mut result = input.to_string();
    for (regex, replacement) in SENSITIVE_PATTERNS.iter() {
        result = regex.replace_all(&result, *replacement).to_string();
    }
    result
}

#[macro_export]
macro_rules! sanitized_log {
    ($level:ident, $($arg:tt)*) => {
        log::$level!("{}", $crate::log_sanitizer::sanitize(&format!($($arg)*)))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_token_in_url() {
        let result = sanitize("ws://127.0.0.1:9817?token=abc123secret");
        assert!(result.contains("token=***"));
        assert!(!result.contains("abc123secret"));
    }

    #[test]
    fn test_redact_password() {
        let result = sanitize("login with password=hunter2 failed");
        assert!(result.contains("password=***"));
        assert!(!result.contains("hunter2"));
    }

    #[test]
    fn test_redact_bearer_token() {
        let result = sanitize("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
        assert!(result.contains("Bearer ***"));
        assert!(!result.contains("eyJhbGci"));
    }

    #[test]
    fn test_redact_json_auth_token() {
        let result = sanitize(r#"{"authToken": "secret-token-123", "port": 9817}"#);
        assert!(result.contains(r#""authToken": "***""#));
        assert!(!result.contains("secret-token-123"));
    }

    #[test]
    fn test_redact_auth_token_variants() {
        assert!(sanitize(r#"{"auth_token": "secret"}"#).contains("***"));
        assert!(sanitize(r#"{"AUTH_TOKEN": "secret"}"#).contains("***"));
        assert!(sanitize(r#"{"apiKey": "secret"}"#).contains("***"));
        assert!(sanitize(r#"{"api_key": "secret"}"#).contains("***"));
    }

    #[test]
    fn test_case_insensitive() {
        assert!(sanitize("TOKEN=abc").contains("TOKEN=***"));
        assert!(sanitize("Password=xyz").contains("Password=***"));
    }

    #[test]
    fn test_no_false_positive() {
        let input = "Method: page.navigate, tabId: 5";
        assert_eq!(sanitize(input), input);
    }

    #[test]
    fn test_empty_input() {
        assert_eq!(sanitize(""), "");
    }

    #[test]
    fn test_multiple_patterns() {
        let input = "token=abc&password=xyz";
        let result = sanitize(input);
        assert!(result.contains("token=***"));
        assert!(result.contains("password=***"));
    }
}
