//! BRP Token Manager
//!
//! Manages per-client tokens. Each MCP client gets its own token,
//! independently revocable. Token file format:
//! { "master": "mt_xxx", "clients": ["ct_aaa", "ct_bbb"] }

use std::collections::HashSet;
use tokio::sync::RwLock;

pub struct TokenManager {
    master_token: String,
    client_tokens: RwLock<HashSet<String>>,
    tokens_file: std::path::PathBuf,
    /// Legacy single-token (backward compat)
    legacy_token: String,
}

impl TokenManager {
    pub fn new(
        master_token: String,
        tokens_file: std::path::PathBuf,
        legacy_token: String,
    ) -> Self {
        let manager = Self {
            master_token,
            client_tokens: RwLock::new(HashSet::new()),
            tokens_file,
            legacy_token,
        };
        // Load from file if available (ok to fail)
        if let Ok(content) = std::fs::read_to_string(&manager.tokens_file) {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(clients) = data.get("clients").and_then(|c| c.as_array()) {
                    let mut tokens = manager
                        .client_tokens
                        .try_write()
                        .expect("RwLock uncontended in constructor");
                    for token in clients {
                        if let Some(t) = token.as_str() {
                            tokens.insert(t.to_string());
                        }
                    }
                }
            }
        }
        manager
    }

    async fn save_to_file(&self) {
        use tokio::io::AsyncWriteExt;
        let tokens = self.client_tokens.read().await;
        let data = serde_json::json!({
            "master": self.master_token,
            "clients": tokens.iter().collect::<Vec<_>>(),
        });
        let content = serde_json::to_string_pretty(&data).unwrap_or_default();

        if let Some(parent) = self.tokens_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp_path = self.tokens_file.with_extension("tmp");
        if let Ok(mut f) = tokio::fs::File::create(&tmp_path).await {
            if f.write_all(content.as_bytes()).await.is_ok() && f.sync_all().await.is_ok() {
                let _ = tokio::fs::rename(&tmp_path, &self.tokens_file).await;
            }
            let _ = tokio::fs::remove_file(&tmp_path).await;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                std::fs::set_permissions(&self.tokens_file, std::fs::Permissions::from_mode(0o600));
        }
    }

    /// Validate a token: master, client tokens, or legacy token.
    pub async fn is_valid_token(&self, provided: &str) -> bool {
        if provided.is_empty() {
            return false;
        }
        // Check master token
        if crate::auth::secure_compare(provided, &self.master_token) {
            return true;
        }
        // Check client tokens
        for token in self.client_tokens.read().await.iter() {
            if crate::auth::secure_compare(provided, token) {
                return true;
            }
        }
        // Check legacy single-token (backward compat)
        crate::auth::secure_compare(provided, &self.legacy_token)
    }

    /// Issue a new client token. Requires master token.
    pub async fn issue_token(&self, requester_token: &str) -> Result<String, &'static str> {
        if !crate::auth::secure_compare(requester_token, &self.master_token) {
            return Err("Master token required to issue client tokens");
        }
        let new_token = format!("ct_{}", uuid::Uuid::new_v4());
        self.client_tokens.write().await.insert(new_token.clone());
        self.save_to_file().await;
        Ok(new_token)
    }

    /// Revoke a client token. Requires master token.
    pub async fn revoke_token(
        &self,
        requester_token: &str,
        token_to_revoke: &str,
    ) -> Result<(), &'static str> {
        if !crate::auth::secure_compare(requester_token, &self.master_token) {
            return Err("Master token required to revoke tokens");
        }
        if crate::auth::secure_compare(token_to_revoke, &self.master_token) {
            return Err("Cannot revoke master token");
        }
        if self.client_tokens.write().await.remove(token_to_revoke) {
            self.save_to_file().await;
            Ok(())
        } else {
            Err("Token not found")
        }
    }

    /// List all client tokens. Requires master token.
    pub async fn list_tokens(&self, requester_token: &str) -> Result<Vec<String>, &'static str> {
        if !crate::auth::secure_compare(requester_token, &self.master_token) {
            return Err("Master token required to list tokens");
        }
        Ok(self.client_tokens.read().await.iter().cloned().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_manager() -> (TokenManager, TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("tokens.json");
        let manager = TokenManager::new("mt_test_master".to_string(), path, String::new());
        (manager, tmp)
    }

    #[tokio::test]
    async fn test_master_token_valid() {
        let (m, _t) = make_manager();
        assert!(m.is_valid_token("mt_test_master").await);
    }

    #[tokio::test]
    async fn test_issue_client_token() {
        let (m, _t) = make_manager();
        let ct = m.issue_token("mt_test_master").await.unwrap();
        assert!(ct.starts_with("ct_"));
        assert!(m.is_valid_token(&ct).await);
    }

    #[tokio::test]
    async fn test_issue_requires_master() {
        let (m, _t) = make_manager();
        assert!(m.issue_token("wrong").await.is_err());
    }

    #[tokio::test]
    async fn test_revoke_token() {
        let (m, _t) = make_manager();
        let ct = m.issue_token("mt_test_master").await.unwrap();
        m.revoke_token("mt_test_master", &ct).await.unwrap();
        assert!(!m.is_valid_token(&ct).await);
    }

    #[tokio::test]
    async fn test_revoke_requires_master() {
        let (m, _t) = make_manager();
        let ct = m.issue_token("mt_test_master").await.unwrap();
        assert!(m.revoke_token("wrong", &ct).await.is_err());
    }

    #[tokio::test]
    async fn test_cannot_revoke_master() {
        let (m, _t) = make_manager();
        assert!(m
            .revoke_token("mt_test_master", "mt_test_master")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn test_revoke_nonexistent() {
        let (m, _t) = make_manager();
        assert!(m
            .revoke_token("mt_test_master", "ct_nonexistent")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn test_invalid_token_rejected() {
        let (m, _t) = make_manager();
        assert!(!m.is_valid_token("invalid").await);
        assert!(!m.is_valid_token("").await);
    }

    #[tokio::test]
    async fn test_independent_revocation() {
        let (m, _t) = make_manager();
        let a = m.issue_token("mt_test_master").await.unwrap();
        let b = m.issue_token("mt_test_master").await.unwrap();
        m.revoke_token("mt_test_master", &a).await.unwrap();
        assert!(!m.is_valid_token(&a).await);
        assert!(m.is_valid_token(&b).await);
    }

    #[tokio::test]
    async fn test_persist_across_restart() {
        let (m, tmp) = make_manager();
        let ct = m.issue_token("mt_test_master").await.unwrap();
        let m2 = TokenManager::new(
            "mt_test_master".to_string(),
            tmp.path().join("tokens.json"),
            String::new(),
        );
        assert!(m2.is_valid_token(&ct).await);
    }

    #[tokio::test]
    async fn test_list_requires_master() {
        let (m, _t) = make_manager();
        m.issue_token("mt_test_master").await.unwrap();
        assert!(m.list_tokens("wrong").await.is_err());
        assert_eq!(m.list_tokens("mt_test_master").await.unwrap().len(), 1);
    }
}
