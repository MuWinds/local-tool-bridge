//! The loopback HTTP transport.
//!
//! This transport serves local process clients: the MCP tunnel and any script
//! that speaks the bridge's JSON-RPC over HTTP. It is request/response, so a
//! client can idle between calls instead of holding a socket open the way the
//! WebSocket transport does. Both share one dispatcher.
//!
//! ## Security
//!
//! Bound to `127.0.0.1` only, and gated by the same shared secret as the
//! WebSocket transport.
//!
//! **The secret — not the `Origin` header — is the security boundary.** CORS is
//! a *read* control, not an execution control: a cross-origin "simple" request
//! is still delivered and executed by the server. A local process can also forge
//! any `Origin` it likes, so an origin allowlist would prove nothing.
//!
//! The origin check below is kept only as a cheap early rejection: the bridge
//! serves no browser origins, so any request carrying one is refused, and a
//! missing `Origin` is explicitly tolerated.

use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use ltb_core::dispatch::{Dispatcher, PeerTrust};
use ltb_core::error::code;
use ltb_core::rpc;

/// Maximum request body accepted, in bytes.
///
/// Tool arguments can legitimately be large (a file to write), but an unbounded
/// body is a trivial denial of service against a local socket.
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// The single RPC endpoint. One path keeps the surface auditable.
const RPC_PATH: &str = "/rpc";

/// A health probe that requires no secret, so the popup can distinguish
/// "host not running" from "host running but secret wrong".
const HEALTH_PATH: &str = "/health";

/// Runs the HTTP server until the process exits.
pub async fn serve(
    listener: TcpListener,
    dispatcher: Arc<Dispatcher>,
    secret: Arc<String>,
) -> std::io::Result<()> {
    let address = listener.local_addr()?;
    tracing::info!(%address, "HTTP transport listening on http://{address}{RPC_PATH}");

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(error) => {
                tracing::warn!(%error, "failed to accept an HTTP connection");
                continue;
            }
        };

        let dispatcher = dispatcher.clone();
        let secret = secret.clone();

        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let dispatcher = dispatcher.clone();
                let secret = secret.clone();
                async move { handle(request, dispatcher, secret, peer).await }
            });

            // HTTP/1.1 with keep-alive: a client may issue several calls in a
            // burst, and connection reuse avoids a handshake per tool call.
            if let Err(error) = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await
            {
                tracing::debug!(%peer, %error, "HTTP connection closed");
            }
        });
    }
}

/// Builds a JSON response with the CORS headers a browser client expects.
fn json_response(status: StatusCode, body: String, origin: Option<&str>) -> Response<Full<Bytes>> {
    let mut builder = Response::builder()
        .status(status)
        .header("content-type", "application/json; charset=utf-8")
        // Browser origins are refused above, but echoing the headers keeps a
        // manual test client (or a preflight) working as expected.
        .header("cache-control", "no-store");

    if let Some(origin) = origin {
        builder = builder
            .header("access-control-allow-origin", origin)
            .header("vary", "origin");
    }

    builder
        .body(Full::new(Bytes::from(body)))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from("{}"))))
}

/// Extracts the `Origin` header, if present and valid UTF-8.
fn origin_of(request: &Request<Incoming>) -> Option<String> {
    request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// True when an origin may call this endpoint.
///
/// The HTTP transport now serves local process clients only (e.g. the MCP
/// tunnel); the shared secret is the gate. No browser `Origin` is permitted,
/// so any request carrying one is rejected here.
fn origin_allowed(_origin: &str) -> bool {
    false
}

/// Handles one HTTP request.
async fn handle(
    request: Request<Incoming>,
    dispatcher: Arc<Dispatcher>,
    secret: Arc<String>,
    peer: SocketAddr,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let origin = origin_of(&request);
    let origin_ref = origin.as_deref();

    // Preflight. Answered before any origin check so the browser can complete
    // the handshake and surface a real error from the actual request.
    if request.method() == Method::OPTIONS {
        let response = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header("access-control-allow-origin", origin_ref.unwrap_or("*"))
            .header("access-control-allow-methods", "POST, GET, OPTIONS")
            .header("access-control-allow-headers", "content-type")
            .header("access-control-max-age", "600")
            .header("vary", "origin")
            .body(Full::new(Bytes::new()))
            .expect("static response must build");
        return Ok(response);
    }

    if request.uri().path() == HEALTH_PATH {
        let body = serde_json::json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
        })
        .to_string();
        return Ok(json_response(StatusCode::OK, body, origin_ref));
    }

    if request.uri().path() != RPC_PATH {
        let body = rpc::encode(&rpc::JsonRpcFailure::bare(ltb_core::BridgeError::new(
            code::INVALID_REQUEST,
            format!("Unknown path `{}`; use {RPC_PATH}", request.uri().path()),
        )))
        .unwrap_or_else(|_| "{}".into());
        return Ok(json_response(StatusCode::NOT_FOUND, body, origin_ref));
    }

    if request.method() != Method::POST {
        let body = rpc::encode(&rpc::JsonRpcFailure::bare(ltb_core::BridgeError::new(
            code::INVALID_REQUEST,
            "Only POST is accepted on /rpc",
        )))
        .unwrap_or_else(|_| "{}".into());
        return Ok(json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            body,
            origin_ref,
        ));
    }

    // A browser sends `Origin`; local process clients do not. Absence is
    // therefore tolerated — the shared secret is the real gate, and a local
    // process could forge an Origin regardless, so rejecting on it alone would
    // be security theatre. Any request that does carry a browser Origin is
    // rejected below, since the bridge no longer serves browser origins.
    if let Some(origin) = &origin {
        if !origin_allowed(origin) {
            tracing::warn!(%origin, %peer, "rejected an HTTP request from a disallowed origin");
            let body = rpc::encode(&rpc::JsonRpcFailure::bare(ltb_core::BridgeError::new(
                code::NOT_AUTHENTICATED,
                format!("Origin `{origin}` is not allowed to call the bridge"),
            )))
            .unwrap_or_else(|_| "{}".into());
            return Ok(json_response(StatusCode::FORBIDDEN, body, origin_ref));
        }
    }

    // The secret may arrive as a header or inside the JSON body. The header is
    // preferred because it keeps the token out of a body that a log or proxy
    // might capture, so it is read before the body is consumed.
    let header_secret = request
        .headers()
        .get("x-dlb-secret")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let body = match request.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(error) => {
            let body = rpc::encode(&rpc::JsonRpcFailure::bare(ltb_core::BridgeError::new(
                code::PARSE_ERROR,
                format!("Failed to read the request body: {error}"),
            )))
            .unwrap_or_else(|_| "{}".into());
            return Ok(json_response(StatusCode::BAD_REQUEST, body, origin_ref));
        }
    };

    if body.len() > MAX_BODY_BYTES {
        let body = rpc::encode(&rpc::JsonRpcFailure::bare(ltb_core::BridgeError::new(
            code::OUTPUT_TOO_LARGE,
            format!("Request body exceeds the {MAX_BODY_BYTES}-byte limit"),
        )))
        .unwrap_or_else(|_| "{}".into());
        return Ok(json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            body,
            origin_ref,
        ));
    }

    let text = String::from_utf8_lossy(&body);

    // Verify the secret before dispatching, mirroring the WebSocket transport.
    // The handshake is the one method exempt from the check.
    let envelope = match rpc::decode_jsonrpc(&text) {
        Ok(value) => value,
        Err(error) => {
            let body =
                rpc::encode(&rpc::JsonRpcFailure::bare(error)).unwrap_or_else(|_| "{}".into());
            return Ok(json_response(StatusCode::BAD_REQUEST, body, origin_ref));
        }
    };

    let is_hello = envelope
        .get("method")
        .and_then(serde_json::Value::as_str)
        .map(|method| method == ltb_core::dispatch::method::HELLO)
        .unwrap_or(false);

    if !is_hello {
        let body_secret = envelope
            .get("params")
            .and_then(|params| params.get("secret"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);

        let provided = header_secret.as_deref().or(body_secret.as_deref());

        if provided != Some(secret.as_str()) {
            let body = rpc::encode(&rpc::JsonRpcFailure::bare(ltb_core::BridgeError::new(
                code::NOT_AUTHENTICATED,
                "Bridge secret did not match; copy the current token from the bridge window",
            )))
            .unwrap_or_else(|_| "{}".into());
            return Ok(json_response(StatusCode::UNAUTHORIZED, body, origin_ref));
        }
    }

    let classified = match rpc::classify(envelope) {
        Ok(value) => value,
        Err(error) => {
            let body =
                rpc::encode(&rpc::JsonRpcFailure::bare(error)).unwrap_or_else(|_| "{}".into());
            return Ok(json_response(StatusCode::BAD_REQUEST, body, origin_ref));
        }
    };

    // The transport cannot vouch for the caller, so it is untrusted in the same
    // way the WebSocket is: the secret verified above is what authorises it.
    let reply = dispatcher.handle(classified, PeerTrust::Untrusted).await;

    let body = match reply {
        Some(value) => rpc::encode(&value).unwrap_or_else(|_| "{}".into()),
        None => "{}".into(),
    };

    Ok(json_response(StatusCode::OK, body, origin_ref))
}

/// Binds the loopback HTTP listener and serves until the process exits.
pub async fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_every_browser_origin() {
        // The bridge serves no browser origins; local process clients send no
        // Origin header and authenticate with the shared secret.
        assert!(!origin_allowed("chrome-extension://abcdef"));
        assert!(!origin_allowed("https://example.com"));
        assert!(!origin_allowed(""));
        assert!(!origin_allowed("https://example.com.attacker.net"));
    }
}
