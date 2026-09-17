//! JSON-RPC 2.0 envelopes.
//!
//! Byte-compatible with `packages/protocol/src/jsonrpc.ts`. Both transports
//! (loopback WebSocket and Chrome native messaging) carry these unchanged, so
//! there is exactly one dispatcher and one set of error semantics.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{code, BridgeError};

pub const JSONRPC_VERSION: &str = "2.0";

/// The bridge protocol version. Bump on any breaking wire change; the
/// handshake refuses a peer whose major version differs.
pub const PROTOCOL_VERSION: &str = "0.1.0";

/// A JSON-RPC id, which the spec allows to be a string or a number.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
}

impl std::fmt::Display for RequestId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RequestId::Number(n) => write!(f, "{n}"),
            RequestId::String(s) => write!(f, "{s}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcSuccess {
    pub jsonrpc: String,
    pub id: RequestId,
    pub result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcFailure {
    pub jsonrpc: String,
    pub id: Option<RequestId>,
    pub error: crate::error::BridgeError,
}

impl JsonRpcSuccess {
    pub fn new(id: RequestId, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            result,
        }
    }
}

impl JsonRpcFailure {
    pub fn new(id: Option<RequestId>, error: BridgeError) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            error,
        }
    }

    /// A failure with no id, used when the request was unparseable.
    pub fn bare(error: BridgeError) -> Self {
        Self::new(None, error)
    }
}

impl JsonRpcNotification {
    pub fn new(method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            method: method.into(),
            params,
        }
    }
}

/// An inbound message, already classified by whether it expects a reply.
#[derive(Debug, Clone)]
pub enum Incoming {
    Request(JsonRpcRequest),
    Notification(JsonRpcNotification),
    /// A reply to a host-originated request (e.g. an approval prompt result).
    Response(Value),
}

/// Parses a transport payload into a JSON value, or a `BridgeError`.
///
/// This is the first step of the inbound path: `decode_jsonrpc` → `classify`.
pub fn decode_jsonrpc(raw: &str) -> Result<Value, BridgeError> {
    serde_json::from_str(raw).map_err(|error| {
        BridgeError::new(
            code::PARSE_ERROR,
            format!("Malformed JSON on the bridge: {error}"),
        )
    })
}

/// Classifies a decoded JSON value into an inbound envelope.
///
/// Anything that is not a well-formed envelope becomes a `BridgeError` the
/// caller can forward as a failure response.
pub fn classify(value: Value) -> Result<Incoming, BridgeError> {
    let object = value.as_object().ok_or_else(|| {
        BridgeError::new(
            code::INVALID_REQUEST,
            "Bridge payload must be a JSON object",
        )
    })?;

    match object.get("jsonrpc").and_then(Value::as_str) {
        Some(JSONRPC_VERSION) => {}
        Some(other) => {
            return Err(BridgeError::new(
                code::INVALID_REQUEST,
                format!("Unsupported JSON-RPC version: {other}"),
            ))
        }
        None => {
            return Err(BridgeError::new(
                code::INVALID_REQUEST,
                "Missing `jsonrpc` version field",
            ))
        }
    }

    let method = object.get("method").and_then(Value::as_str);

    match (method, object.contains_key("id")) {
        (Some(_), true) => serde_json::from_value(value)
            .map(Incoming::Request)
            .map_err(|e| {
                BridgeError::new(code::INVALID_REQUEST, format!("Malformed request: {e}"))
            }),
        (Some(_), false) => serde_json::from_value(value)
            .map(Incoming::Notification)
            .map_err(|e| {
                BridgeError::new(
                    code::INVALID_REQUEST,
                    format!("Malformed notification: {e}"),
                )
            }),
        // No method: it must be a response to something we sent.
        (None, _) => Ok(Incoming::Response(value)),
    }
}

/// Serialises an envelope for the wire.
pub fn encode<T: Serialize>(value: &T) -> Result<String, BridgeError> {
    serde_json::to_string(value)
        .map_err(|e| BridgeError::internal(format!("Failed to encode bridge message: {e}")))
}
