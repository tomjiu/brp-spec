/// BRP Bridge — Operating Mode
///
/// Three modes:
///   bridge    (default) — full WebSocket server + Native Messaging I/O
///   bootstrap           — launched by Firefox connectNative: token delivery via stdout, then hang
///   echo                — diagnostic: echo stdin back to stdout in NM format
///
/// CLI:
///   ./brp-bridge                    → bridge mode (default)
///   ./brp-bridge --mode=bootstrap   → bootstrap mode
///   ./brp-bridge --echo             → echo mode (overrides --mode)
///   ./brp-bridge --help             → usage text

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeMode {
    Bridge,
    Bootstrap,
    Echo,
}

/// Parse CLI arguments into a BridgeMode.
/// Exits with usage text on `--help` or unknown flags.
pub fn parse_mode() -> BridgeMode {
    let args: Vec<String> = std::env::args().collect();
    let mut mode = BridgeMode::Bridge;

    for arg in &args[1..] {
        match arg.as_str() {
            "--help" | "-h" => {
                print_usage(&args[0]);
                std::process::exit(0);
            }
            "--echo" => {
                mode = BridgeMode::Echo;
            }
            "--mode=bridge" => {
                // Explicit default, no-op unless overridden later by --echo
                if mode != BridgeMode::Echo {
                    mode = BridgeMode::Bridge;
                }
            }
            "--mode=bootstrap" => {
                if mode != BridgeMode::Echo {
                    mode = BridgeMode::Bootstrap;
                }
            }
            s if s.starts_with("--mode=") => {
                eprintln!("Unknown mode: {}", &s[7..]);
                eprintln!("Valid modes: bridge, bootstrap");
                std::process::exit(1);
            }
            // Firefox Native Messaging passes manifest path as positional arg on Windows.
            // The extension origin may also appear as a positional arg on Linux/macOS.
            // Silently skip unknown non-flag arguments.
            s if !s.starts_with("-") => {
                // positional argument — silently ignored
                log::debug!("[Mode] Ignoring positional argument: {}", s);
            }
            s => {
                eprintln!("Unknown argument: {}", s);
                eprintln!("Use --help for usage.");
                std::process::exit(1);
            }
        }
    }

    mode
}

fn print_usage(program: &str) {
    println!("BRP Bridge v{}", env!("CARGO_PKG_VERSION"));
    println!();
    println!("Usage: {} [OPTIONS]", program);
    println!();
    println!("Options:");
    println!("  --mode=MODE     Operating mode (default: bridge)");
    println!("                  bridge    — Full WebSocket server + Native Messaging I/O");
    println!("                  bootstrap — Token delivery via stdout (for Firefox connectNative)");
    println!("  --echo          Diagnostic mode: echo stdin back to stdout in NM format");
    println!("                  (overrides --mode)");
    println!("  --help, -h      Show this help");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_mode() {
        // Can't easily test env::args in unit tests, but the enum values work
        assert_ne!(BridgeMode::Bridge, BridgeMode::Bootstrap);
        assert_ne!(BridgeMode::Bridge, BridgeMode::Echo);
    }
}
