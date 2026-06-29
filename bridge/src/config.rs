/// BRP Bridge Configuration
///
/// Reads environment variables at startup and provides a typed config.
/// Token generation and file persistence logic lives here to keep main.rs focused.
use std::path::PathBuf;

/// Typed configuration for the Bridge, loaded once at startup.
#[derive(Clone, Debug)]
pub struct BridgeConfig {
    /// WebSocket address for the Firefox Extension to connect to
    pub ws_addr: String,
    /// Authentication token (auto-generated UUID v4 or from BRP_AUTH_TOKEN env)
    pub auth_token: String,
    /// Platform-specific path to the token file
    pub token_file_path: PathBuf,
    /// Whether to run in standalone mode (WebSocket only, no stdin/stdout)
    pub standalone: bool,
    /// Whether script.execute is allowed (BRP_ALLOW_SCRIPT_EXECUTE=1)
    pub allow_script_execute: bool,
    /// B2: Master token (for issuing/revoking client tokens)
    pub master_token: String,
    /// B2: Path to multi-token storage file
    pub tokens_file_path: PathBuf,
}

impl BridgeConfig {
    /// Load all configuration from environment variables.
    /// Token is auto-generated if not provided via BRP_AUTH_TOKEN,
    /// and written to a platform-specific file with 0600 permissions.
    pub fn load() -> Self {
        let ws_addr = std::env::var("BRP_WS_ADDR").unwrap_or_else(|_| "127.0.0.1:9817".to_string());

        let token_file_path = default_token_path();

        let auth_token = std::env::var("BRP_AUTH_TOKEN")
            .ok()
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| {
                let token = uuid::Uuid::new_v4().to_string();
                if let Err(e) = write_token_to_file(&token, &token_file_path) {
                    log::warn!("[Auth] Failed to write token file: {}", e);
                } else {
                    log::info!("[Auth] Token written to {}", token_file_path.display());
                }
                log::info!("[Auth] Auto-generated token: configure in Extension Options page");
                token
            });

        let standalone = std::env::var("BRP_STANDALONE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        let allow_script_execute = std::env::var("BRP_ALLOW_SCRIPT_EXECUTE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        // ── B2 Multi-token ──
        let master_token = std::env::var("BRP_MASTER_TOKEN")
            .ok()
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| format!("mt_{}", uuid::Uuid::new_v4()));

        let tokens_file_path = default_tokens_file_path();

        Self {
            ws_addr,
            auth_token,
            token_file_path,
            standalone,
            allow_script_execute,
            master_token,
            tokens_file_path,
        }
    }
}

/// Write the auth token to a file atomically (write to .tmp, sync, rename).
/// On Unix, sets file permissions to 0600.
fn write_token_to_file(token: &str, path: &std::path::Path) -> std::io::Result<()> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let tmp_path = path.with_extension("tmp");

    let mut f = std::fs::File::create(&tmp_path)?;
    f.write_all(token.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp_path, path)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

/// Determine the platform-specific token file path.
fn default_token_path() -> PathBuf {
    // Explicit override
    if let Ok(p) = std::env::var("BRP_TOKEN_FILE") {
        return PathBuf::from(p);
    }

    // Windows: %APPDATA%\brp-bridge\token
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("brp-bridge").join("token");
        }
    }

    // Unix / macOS: $HOME/.brp-bridge-token
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".brp-bridge-token");
    }

    // Fallback: system temp dir
    std::env::temp_dir().join("brp-bridge-token")
}

/// B2: Determine the multi-token storage file path.
fn default_tokens_file_path() -> PathBuf {
    if let Ok(p) = std::env::var("BRP_TOKENS_FILE") {
        return PathBuf::from(p);
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata)
                .join("brp-bridge")
                .join("tokens.json");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".brp-bridge").join("tokens.json");
    }
    std::env::temp_dir().join("brp-bridge-tokens.json")
}
