#![allow(dead_code)]

/// Firefox Native Messaging Transport
///
/// Firefox communicates with native applications using stdin/stdout with
/// a specific message format:
/// - Send:    [4-byte message length (native endian u32)] [UTF-8 JSON]
/// - Receive: [4-byte message length (native endian u32)] [UTF-8 JSON]
///
/// Reference: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging
use serde_json::Value;
use std::io::{self, Read, Write};

/// Read a single native message from stdin (blocking)
pub fn read_native_message() -> io::Result<Option<Value>> {
    let stdin = io::stdin();
    let mut handle = stdin.lock();

    // Read 4-byte length prefix (native endian)
    let mut len_buf = [0u8; 4];
    match handle.read_exact(&mut len_buf) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let len = u32::from_ne_bytes(len_buf) as usize;

    // Sanity check: Firefox limits messages to 1MB
    if len > 1_048_576 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Message too large: {} bytes (max 1MB)", len),
        ));
    }

    // Read JSON payload
    let mut buf = vec![0u8; len];
    handle.read_exact(&mut buf)?;

    let text = String::from_utf8(buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("Invalid UTF-8: {}", e)))?;

    let value: Value = serde_json::from_str(&text)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("Invalid JSON: {}", e)))?;

    Ok(Some(value))
}

/// Write a single native message to stdout (blocking)
pub fn write_native_message(msg: &Value) -> io::Result<()> {
    let json = serde_json::to_string(msg).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("JSON serialization failed: {}", e),
        )
    })?;

    let bytes = json.as_bytes();
    let len = bytes.len() as u32;

    let stdout = io::stdout();
    let mut handle = stdout.lock();

    // Write 4-byte length prefix (native endian)
    handle.write_all(&len.to_ne_bytes())?;
    // Write JSON payload
    handle.write_all(bytes)?;
    handle.flush()?;

    Ok(())
}

/// Async wrapper for writing native messages
pub async fn send_native_message(msg: &Value) -> io::Result<()> {
    let msg = msg.clone();
    tokio::task::spawn_blocking(move || write_native_message(&msg))
        .await
        .map_err(|e| io::Error::other(format!("Join error: {}", e)))?
}
