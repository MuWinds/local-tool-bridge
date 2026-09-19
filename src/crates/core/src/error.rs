//! Error types and JSON-RPC error codes.
//!
//! The numeric codes here are the wire contract: stable integers a client can
//! branch on without parsing an English message.

use serde::{Deserialize, Serialize};

/// Standard JSON-RPC 2.0 codes plus the bridge's implementation-defined range.
///
/// `-32000..=-32099` is reserved by the specification for implementation-defined
/// server errors, which is exactly where every bridge-specific failure lives.
pub mod code {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;

    pub const HOST_UNAVAILABLE: i64 = -32000;
    pub const NOT_AUTHENTICATED: i64 = -32001;
    pub const PROTOCOL_MISMATCH: i64 = -32002;

    pub const TOOL_NOT_FOUND: i64 = -32010;
    pub const TOOL_DENIED: i64 = -32011;
    pub const APPROVAL_REQUIRED: i64 = -32012;
    pub const APPROVAL_TIMEOUT: i64 = -32013;
    pub const PATH_NOT_ALLOWED: i64 = -32014;
    pub const TOOL_TIMEOUT: i64 = -32016;
    pub const OUTPUT_TOO_LARGE: i64 = -32017;
    pub const RATE_LIMITED: i64 = -32018;
}

/// A failure that carries a JSON-RPC code across the bridge.
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct BridgeError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl BridgeError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    /// Attaches structured detail the page can act on (a path, a token, a limit).
    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(code::INTERNAL_ERROR, message)
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(code::INVALID_PARAMS, message)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(code::METHOD_NOT_FOUND, format!("Unknown method: {method}"))
    }

    pub fn tool_not_found(name: &str) -> Self {
        Self::new(code::TOOL_NOT_FOUND, format!("Unknown tool: {name}"))
    }

    pub fn denied(reason: impl Into<String>) -> Self {
        Self::new(code::TOOL_DENIED, reason)
    }

    pub fn path_not_allowed(message: impl Into<String>) -> Self {
        Self::new(code::PATH_NOT_ALLOWED, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(code::TOOL_TIMEOUT, message)
    }

    /// Convenience for `?` in handlers that only produce `io::Error`.
    pub fn from_io(context: &str, error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => code::INVALID_PARAMS,
            std::io::ErrorKind::PermissionDenied => code::PATH_NOT_ALLOWED,
            std::io::ErrorKind::TimedOut => code::TOOL_TIMEOUT,
            _ => code::INTERNAL_ERROR,
        };
        Self::new(code, format!("{context}: {error}"))
    }
}

pub type Result<T, E = BridgeError> = std::result::Result<T, E>;
