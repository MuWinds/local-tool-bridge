//! The Chrome native messaging transport.
//!
//! Chrome launches this binary as a child process and speaks a framed protocol
//! over stdin/stdout: a 4-byte little-endian length prefix followed by UTF-8
//! JSON.
//!
//! **The size limits are asymmetric, and getting them backwards is a common
//! bug.** Chrome allows up to **1 MB** for a host→browser message but up to
//! **64 MB** for a browser→host message. Clamping the inbound direction to 1 MB
//! would reject a legitimate large request (a file to write); clamping the
//! outbound direction to 64 MB would let Chrome silently drop the reply.
//!
//! This transport is stricter than the loopback ones because Chrome itself
//! enforces the allowlist: only the extension id named in the host manifest can
//! launch the process. That makes it the right choice for a packaged release.
//!
//! **stdout is the wire.** Nothing may print to it. A single stray `println!`
//! shifts every subsequent frame boundary and permanently desynchronises the
//! channel, which is why all diagnostics go to stderr.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use ltb_core::dispatch::{Dispatcher, PeerTrust};
use ltb_core::rpc::{self, Incoming};

/// Chrome's maximum for a host→browser message. Exceeding it makes Chrome drop
/// the message.
const MAX_OUTBOUND_BYTES: usize = 1024 * 1024;

/// Chrome's maximum for a browser→host message.
const MAX_INBOUND_BYTES: usize = 64 * 1024 * 1024;

/// Reads frames from `reader`, dispatching each and writing replies to `writer`.
///
/// Returns when stdin reaches EOF, which is how Chrome signals shutdown.
pub async fn serve<R, W>(
    mut reader: R,
    mut writer: W,
    dispatcher: Arc<Dispatcher>,
) -> std::io::Result<()>
where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let mut events = dispatcher.subscribe();
    let mut authenticated = false;

    loop {
        tokio::select! {
            frame = read_frame(&mut reader) => {
                let Some(payload) = frame? else { break };

                let envelope = match rpc::decode_jsonrpc(&payload) {
                    Ok(value) => value,
                    Err(error) => {
                        write_message(&mut writer, &rpc::JsonRpcFailure::bare(error)).await?;
                        continue;
                    }
                };

                let classified = match rpc::classify(envelope) {
                    Ok(value) => value,
                    Err(error) => {
                        write_message(&mut writer, &rpc::JsonRpcFailure::bare(error)).await?;
                        continue;
                    }
                };

                // Chrome has already proven the caller is the allowlisted
                // extension: it only launches a host binary named in that
                // extension's manifest, and the OS-level launch is the
                // authentication. So no shared secret is requested here — and
                // requiring one would make this transport unusable, because
                // Chrome never sends it.
                //
                // The flag still gates event delivery, so nothing is pushed
                // before the handshake establishes a protocol version.
                if !authenticated {
                    if let Incoming::Request(request) = &classified {
                        if request.method == ltb_core::dispatch::method::HELLO {
                            authenticated = true;
                        }
                    }
                }

                if let Some(reply) = dispatcher.handle(classified, PeerTrust::Verified).await {
                    write_message(&mut writer, &reply).await?;
                }
            }

            event = events.recv() => {
                match event {
                    Ok(value) => {
                        if authenticated {
                            write_message(&mut writer, &value).await?;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "native messaging client fell behind");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    Ok(())
}

/// Reads one length-prefixed frame, or `None` at a clean EOF.
async fn read_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> std::io::Result<Option<String>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    let length = u32::from_le_bytes(header) as usize;
    if length == 0 {
        return Ok(Some(String::new()));
    }
    // A hostile or corrupt length would otherwise allocate unbounded memory.
    if length > MAX_INBOUND_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("native message of {length} bytes exceeds the {MAX_INBOUND_BYTES}-byte limit"),
        ));
    }

    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    Ok(Some(String::from_utf8_lossy(&body).into_owned()))
}

/// Writes one length-prefixed frame, replacing an oversized payload with an error.
async fn write_message<W, T>(writer: &mut W, value: &T) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
    T: serde::Serialize,
{
    let json = match serde_json::to_string(value) {
        Ok(json) => json,
        Err(error) => {
            tracing::error!(%error, "failed to serialise a native messaging reply");
            return Ok(());
        }
    };

    let bytes = json.as_bytes();
    if bytes.len() > MAX_OUTBOUND_BYTES {
        // Chrome would drop the message and may terminate the host, so send a
        // structured error the extension can surface instead.
        let fallback = serde_json::json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {
                "code": ltb_core::error::code::OUTPUT_TOO_LARGE,
                "message": format!(
                    "Reply was {} bytes, over the {MAX_OUTBOUND_BYTES}-byte native messaging limit",
                    bytes.len()
                )
            }
        });
        let fallback = serde_json::to_string(&fallback).unwrap_or_else(|_| "{}".into());
        return write_frame(writer, fallback.as_bytes()).await;
    }

    write_frame(writer, bytes).await
}

/// Writes the length prefix and body, then flushes.
async fn write_frame<W: AsyncWriteExt + Unpin>(writer: &mut W, body: &[u8]) -> std::io::Result<()> {
    let header = (body.len() as u32).to_le_bytes();
    writer.write_all(&header).await?;
    writer.write_all(body).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encodes a frame the way Chrome would.
    fn encode(payload: &str) -> Vec<u8> {
        let body = payload.as_bytes();
        let mut frame = (body.len() as u32).to_le_bytes().to_vec();
        frame.extend_from_slice(body);
        frame
    }

    #[tokio::test]
    async fn reads_a_single_frame() {
        let frame = encode(r#"{"jsonrpc":"2.0"}"#);
        let mut reader = std::io::Cursor::new(frame);
        let payload = read_frame(&mut reader).await.unwrap();
        assert_eq!(payload.unwrap(), r#"{"jsonrpc":"2.0"}"#);
    }

    #[tokio::test]
    async fn reads_consecutive_frames() {
        let mut bytes = encode(r#"{"a":1}"#);
        bytes.extend_from_slice(&encode(r#"{"b":2}"#));

        let mut reader = std::io::Cursor::new(bytes);
        assert_eq!(
            read_frame(&mut reader).await.unwrap().unwrap(),
            r#"{"a":1}"#
        );
        assert_eq!(
            read_frame(&mut reader).await.unwrap().unwrap(),
            r#"{"b":2}"#
        );
    }

    #[tokio::test]
    async fn returns_none_at_clean_eof() {
        let mut reader = std::io::Cursor::new(Vec::new());
        assert!(read_frame(&mut reader).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rejects_an_oversized_length_prefix() {
        // A corrupt prefix must not cause a huge allocation.
        let mut frame = ((MAX_INBOUND_BYTES + 1) as u32).to_le_bytes().to_vec();
        frame.push(0);
        let mut reader = std::io::Cursor::new(frame);
        assert!(read_frame(&mut reader).await.is_err());
    }

    #[tokio::test]
    async fn accepts_an_inbound_frame_larger_than_the_outbound_cap() {
        // The limits are asymmetric: Chrome permits 64 MB inbound but only 1 MB
        // outbound. Clamping inbound to the outbound cap would wrongly reject a
        // legitimate large request.
        let body = "x".repeat(MAX_OUTBOUND_BYTES + 1024);
        let frame = encode(&body);
        let mut reader = std::io::Cursor::new(frame);
        let payload = read_frame(&mut reader).await.unwrap().unwrap();
        assert_eq!(payload.len(), body.len());
    }

    #[tokio::test]
    async fn writes_a_length_prefixed_frame() {
        let mut out = Vec::new();
        write_message(&mut out, &serde_json::json!({"ok": true}))
            .await
            .unwrap();

        let declared = u32::from_le_bytes([out[0], out[1], out[2], out[3]]) as usize;
        assert_eq!(declared, out.len() - 4);
        let body = String::from_utf8(out[4..].to_vec()).unwrap();
        assert!(body.contains("\"ok\":true"));
    }

    #[tokio::test]
    async fn replaces_an_oversized_payload_with_a_structured_error() {
        let mut out = Vec::new();
        // A string that serialises beyond the outbound cap.
        let huge = "x".repeat(MAX_OUTBOUND_BYTES + 10);
        write_message(&mut out, &serde_json::json!({ "body": huge }))
            .await
            .unwrap();

        let body = String::from_utf8(out[4..].to_vec()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            parsed["error"]["code"],
            ltb_core::error::code::OUTPUT_TOO_LARGE
        );
    }
}
