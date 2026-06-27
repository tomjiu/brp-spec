/// BRP Bridge — Rate Limiting
///
/// Server-side connection throttling applied before the WebSocket upgrade.
/// Tracks recent connection attempts in a 1-second sliding window and limits
/// concurrent unauthenticated (pending registration) connections.
///
/// **Design note — self-DoS risk:** Limiting unauthenticated connections to 5
/// prevents connection exhaustion, but 5 pending connections × registration
/// timeout (default 10s) could briefly saturate the slot, blocking legitimate
/// new connections. This is acceptable for MVP. Future mitigation: dynamic
/// timeout reduction under load, or per-IP rate limiting.
use std::time::Instant;

// ─── Constants ───

/// Maximum number of concurrent unauthenticated WebSocket connections.
pub const MAX_UNAUTHENTICATED_CONNECTIONS: usize = 5;

/// Maximum connections per second from loopback.
pub const MAX_CONNECTIONS_PER_SECOND: usize = 10;

// ─── Rate Limiter ───

/// Rate limiter state for server-side connection throttling.
pub struct RateLimiter {
    /// Timestamps of recent connection attempts (sliding window).
    recent_connections: Vec<Instant>,
    /// Current number of unauthenticated (pending registration) connections.
    unauthenticated_count: usize,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            recent_connections: Vec::new(),
            unauthenticated_count: 0,
        }
    }

    /// Check if a new connection should be accepted.
    /// Returns Ok(()) if allowed, Err(reason) if rate-limited.
    pub fn check_connection(&mut self) -> Result<(), &'static str> {
        let now = Instant::now();

        // Prune entries older than 1 second
        self.recent_connections
            .retain(|t| now.duration_since(*t).as_secs_f64() < 1.0);

        // Check connections per second
        if self.recent_connections.len() >= MAX_CONNECTIONS_PER_SECOND {
            return Err("Too many connections per second");
        }

        // Check concurrent unauthenticated connections
        if self.unauthenticated_count >= MAX_UNAUTHENTICATED_CONNECTIONS {
            return Err("Too many unauthenticated connections");
        }

        self.recent_connections.push(now);
        self.unauthenticated_count += 1;
        Ok(())
    }

    /// Called when a connection completes authentication successfully.
    pub fn on_authenticated(&mut self) {
        self.unauthenticated_count = self.unauthenticated_count.saturating_sub(1);
    }

    /// Called when a connection fails authentication or disconnects before
    /// authenticating.
    pub fn on_auth_failed(&mut self) {
        self.unauthenticated_count = self.unauthenticated_count.saturating_sub(1);
    }
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn test_rate_limiter_allows_under_limit() {
        let mut rl = RateLimiter::new();

        // First connection should succeed
        assert!(rl.check_connection().is_ok());

        // Second connection should also succeed (under both limits)
        assert!(rl.check_connection().is_ok());

        // unauthenticated_count should be 2
        assert_eq!(rl.unauthenticated_count, 2);
    }

    #[test]
    fn test_rate_limiter_blocks_over_cps_limit() {
        let mut rl = RateLimiter::new();

        // Fill up to MAX_CONNECTIONS_PER_SECOND, authenticating each one
        // so the unauthenticated limit doesn't kick in first.
        for i in 0..MAX_CONNECTIONS_PER_SECOND {
            assert!(
                rl.check_connection().is_ok(),
                "connection {} should succeed",
                i
            );
            rl.on_authenticated();
        }

        // Next connection should be rate-limited (too many per second)
        let result = rl.check_connection();
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Too many connections per second");
    }

    #[test]
    fn test_rate_limiter_blocks_over_unauth_limit() {
        let mut rl = RateLimiter::new();

        // Accept MAX_UNAUTHENTICATED_CONNECTIONS without authenticating any
        for _ in 0..MAX_UNAUTHENTICATED_CONNECTIONS {
            assert!(rl.check_connection().is_ok());
        }

        // Next should fail due to unauthenticated limit
        let result = rl.check_connection();
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Too many unauthenticated connections");
    }

    #[test]
    fn test_rate_limiter_on_authenticated_frees_slot() {
        let mut rl = RateLimiter::new();

        // Fill unauthenticated slots
        for _ in 0..MAX_UNAUTHENTICATED_CONNECTIONS {
            assert!(rl.check_connection().is_ok());
        }

        // Should be blocked
        assert!(rl.check_connection().is_err());

        // Authenticate one connection
        rl.on_authenticated();
        assert_eq!(
            rl.unauthenticated_count,
            MAX_UNAUTHENTICATED_CONNECTIONS - 1
        );

        // Now one more should succeed
        assert!(rl.check_connection().is_ok());
    }

    #[test]
    fn test_rate_limiter_on_auth_failed_frees_slot() {
        let mut rl = RateLimiter::new();

        // Fill unauthenticated slots
        for _ in 0..MAX_UNAUTHENTICATED_CONNECTIONS {
            assert!(rl.check_connection().is_ok());
        }

        // Should be blocked
        assert!(rl.check_connection().is_err());

        // One auth failure
        rl.on_auth_failed();
        assert_eq!(
            rl.unauthenticated_count,
            MAX_UNAUTHENTICATED_CONNECTIONS - 1
        );

        // Now one more should succeed
        assert!(rl.check_connection().is_ok());
    }

    #[test]
    fn test_rate_limiter_window_expiry() {
        let mut rl = RateLimiter::new();

        // Manually fill the recent_connections with old timestamps
        // to simulate the window having passed.
        let old = Instant::now() - Duration::from_secs(2);
        for _ in 0..MAX_CONNECTIONS_PER_SECOND {
            rl.recent_connections.push(old);
        }

        // Also fill unauth count to its limit
        rl.unauthenticated_count = MAX_UNAUTHENTICATED_CONNECTIONS;

        // CPS check: the old entries should be pruned (older than 1s),
        // so the CPS limit won't trigger.
        // But unauthenticated_count is still at max, so it will fail on that.
        let result = rl.check_connection();
        assert_eq!(result.unwrap_err(), "Too many unauthenticated connections");

        // The old entries should have been pruned though
        // (only the new one we just attempted isn't there since we failed)
        assert!(rl.recent_connections.is_empty());

        // Free an unauth slot and try again
        rl.on_authenticated();
        assert!(rl.check_connection().is_ok());
        // recent_connections should now have exactly 1 entry
        assert_eq!(rl.recent_connections.len(), 1);
    }

    #[test]
    fn test_rate_limiter_saturating_sub() {
        let mut rl = RateLimiter::new();

        // Calling on_authenticated / on_auth_failed when count is 0 should not panic
        rl.on_authenticated();
        assert_eq!(rl.unauthenticated_count, 0);

        rl.on_auth_failed();
        assert_eq!(rl.unauthenticated_count, 0);
    }
}
