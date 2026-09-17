//! The loopback WebSocket transport.
//!
//! The extension's service worker connects here because it is the simplest
//! channel to develop against. Three properties make it safe enough to expose:
//!
//! 1. **Bound to `127.0.0.1` only** — never `0.0.0.0`, so the socket is not
//!    reachable from the LAN.
//! 2. **Shared-secret handshake** — the first message must be a `bridge.hello`
//!    carrying the token printed in the GUI. A random web page that discovers
//!    the port cannot call a tool without it.
//! 3. **Origin check** — the `Origin` header must be a DeepSeek page or an
//!    extension origin. This is defence in depth, not the primary boundary:
//!    any local process can forge an Origin header, which is exactly why the
//!    secret exists.
//!
//! Native messaging is the stricter transport (Chrome enforces the extension
//! allowlist); this one is the convenient one. Both feed the same dispatcher.

use std::net::SocketAddr;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use ltb_core::dispatch::{Dispatcher, PeerTrust};
use ltb_core::rpc::{self, Incoming};

/// Origins permitted to open a WebSocket.
const ALLOWED_ORIGIN_SUFFIXES: &[&str] = &[
    "chat.deepseek.com",
    // Chrome extension service workers send an origin of the form
    // `chrome-extension://<id>`; any id is accepted here because the shared
    // secret, not the origin, is the actual gate.
    "chrome-extension://",
    "moz-extension://",
];

/// Returns `true` when an `Origin` header value is acceptable.
fn origin_allowed(origin: &str) -> bool {
    if origin.is_empty() {
        return false;
    }
    ALLOWED_ORIGIN_SUFFIXES.iter().any(|suffix| {
        if suffix.ends_with("://") {
            origin.starts_with(suffix)
        } else {
            // Match the host exactly or as a subdomain, so `evil-chat.deepseek.com`
            // is rejected while `chat.deepseek.com` is accepted.
            origin == format!("https://{suffix}")
                || origin.ends_with(&format!(".{suffix}"))
                || origin == format!("http://{suffix}")
        }
    })
}

/// Runs the WebSocket server until the process ends.
pub async fn serve(
    listener: TcpListener,
    dispatcher: Arc<Dispatcher>,
    secret: Arc<String>,
) -> std::io::Result<()> {
    let address = listener.local_addr()?;
    tracing::info!(%address, "WebSocket transport listening");

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(error) => {
                tracing::warn!(%error, "failed to accept a WebSocket connection");
                continue;
            }
        };

        let dispatcher = dispatcher.clone();
        let secret = secret.clone();

        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, peer, dispatcher, secret).await {
                tracing::debug!(%peer, %error, "WebSocket connection closed");
            }
        });
    }
}

/// Accepts one connection and pumps messages until it closes.
async fn handle_connection(
    stream: tokio::net::TcpStream,
    peer: SocketAddr,
    dispatcher: Arc<Dispatcher>,
    secret: Arc<String>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Reject a disallowed Origin during the handshake, before any message is
    // read, so a hostile page never reaches the dispatcher at all.
    //
    // The large `Err` variant is tungstenite's own `ErrorResponse`, which this
    // callback's signature requires; it cannot be boxed without reimplementing
    // the handshake.
    #[allow(clippy::result_large_err)]
    let callback = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let origin = request
            .headers()
            .get("origin")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();

        if origin_allowed(&origin) {
            return Ok(response);
        }

        tracing::warn!(%origin, %peer, "rejected a WebSocket handshake from a disallowed origin");
        let mut rejection = ErrorResponse::new(Some("Origin not allowed".to_string()));
        *rejection.status_mut() = StatusCode::FORBIDDEN;
        Err(rejection)
    };

    let websocket = tokio_tungstenite::accept_hdr_async(stream, callback).await?;
    tracing::info!(%peer, "WebSocket client connected");

    let (mut sink, mut source) = websocket.split();

    // The secret is verified by the dispatcher's `bridge.hello` handler, so the
    // transport only needs to make it available on the first request.
    let mut authenticated = false;
    let mut events = dispatcher.subscribe();

    loop {
        tokio::select! {
            incoming = source.next() => {
                let Some(message) = incoming else { break };
                let message = message?;

                let text = match message {
                    // tungstenite 0.26 wraps text frames in `Utf8Bytes`.
                    Message::Text(text) => text.to_string(),
                    Message::Binary(bytes) => match String::from_utf8(bytes.to_vec()) {
                        Ok(text) => text,
                        Err(_) => continue,
                    },
                    Message::Close(_) => break,
                    // Ping/Pong are handled by tungstenite.
                    _ => continue,
                };

                let envelope = match rpc::decode_jsonrpc(&text) {
                    Ok(value) => value,
                    Err(error) => {
                        let failure = rpc::JsonRpcFailure::bare(error);
                        let encoded = rpc::encode(&failure)?;
                        sink.send(Message::Text(encoded.into())).await?;
                        continue;
                    }
                };

                let classified = match rpc::classify(envelope) {
                    Ok(value) => value,
                    Err(error) => {
                        let failure = rpc::JsonRpcFailure::bare(error);
                        let encoded = rpc::encode(&failure)?;
                        sink.send(Message::Text(encoded.into())).await?;
                        continue;
                    }
                };

                // Enforce the secret before dispatching anything except the
                // handshake itself.
                if !authenticated {
                    let is_hello = matches!(
                        &classified,
                        Incoming::Request(request) if request.method == ltb_core::dispatch::method::HELLO
                    );
                    if !is_hello {
                        let failure = rpc::JsonRpcFailure::bare(ltb_core::BridgeError::new(
                            ltb_core::error::code::NOT_AUTHENTICATED,
                            "Send `bridge.hello` with the bridge secret before any other method",
                        ));
                        sink.send(Message::Text(rpc::encode(&failure)?.into())).await?;
                        continue;
                    }

                    // Verify the secret up front so the dispatcher's own check
                    // is a second line of defence rather than the only one.
                    if let Incoming::Request(request) = &classified {
                        let provided = request
                            .params
                            .as_ref()
                            .and_then(|params| params.get("secret"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default();
                        if provided != secret.as_str() {
                            let failure = rpc::JsonRpcFailure::bare(ltb_core::BridgeError::new(
                                ltb_core::error::code::NOT_AUTHENTICATED,
                                "Bridge secret did not match",
                            ));
                            sink.send(Message::Text(rpc::encode(&failure)?.into())).await?;
                            continue;
                        }
                        authenticated = true;
                        tracing::info!(%peer, "WebSocket client authenticated");
                    }
                }

                if let Some(reply) = dispatcher.handle(classified, PeerTrust::Untrusted).await {
                    sink.send(Message::Text(rpc::encode(&reply)?.into())).await?;
                }
            }

            event = events.recv() => {
                match event {
                    Ok(value) => {
                        // Only push events to an authenticated peer; an
                        // unauthenticated socket must not observe activity.
                        if authenticated {
                            sink.send(Message::Text(rpc::encode(&value)?.into())).await?;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "WebSocket client fell behind on events");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    tracing::info!(%peer, "WebSocket client disconnected");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_deepseek_and_extension_origins() {
        assert!(origin_allowed("https://chat.deepseek.com"));
        assert!(origin_allowed("chrome-extension://abcdefghijklmnop"));
        assert!(origin_allowed("moz-extension://abc"));
    }

    #[test]
    fn rejects_a_lookalike_host() {
        // The suffix check must not be fooled by a domain that merely ends with
        // the allowed host.
        assert!(!origin_allowed(
            "https://evil-chat.deepseek.com.attacker.net"
        ));
        assert!(!origin_allowed("https://notdeepseek.com"));
    }

    #[test]
    fn rejects_an_empty_or_unrelated_origin() {
        assert!(!origin_allowed(""));
        assert!(!origin_allowed("https://example.com"));
    }

    #[test]
    fn accepts_a_deepseek_subdomain() {
        assert!(origin_allowed("https://www.chat.deepseek.com"));
    }
}
