//! `ltb-core` — the transport-agnostic core of the local tool bridge.
//!
//! Nothing in this crate knows which transport a call arrived on: every loopback
//! transport feeds the same `Dispatcher`, which owns validation, policy,
//! approval, execution, and audit.
//!
//! The GUI depends on this crate too, which is why it must stay free of any
//! windowing or platform-specific code.

pub mod audit;
pub mod dispatch;
pub mod error;
pub mod policy;
pub mod rpc;
pub mod tools;

pub use audit::{AuditEntry, AuditLog, AuditOutcome};
pub use dispatch::{ApprovalChallenge, ApprovalDecision, Approver, Dispatcher};
pub use error::{BridgeError, Result};
pub use policy::{Effect, Policy, PolicyEngine, Rule, Verdict};
pub use rpc::{Incoming, JsonRpcFailure, JsonRpcSuccess, RequestId, PROTOCOL_VERSION};
pub use tools::{Tool, ToolContext, ToolDescriptor, ToolOutput, ToolRegistry};

/// Where the host keeps its state, per platform.
///
/// - Windows: `%APPDATA%\local-tool-bridge`
/// - macOS:   `~/Library/Application Support/local-tool-bridge`
/// - Linux:   `~/.config/local-tool-bridge` (or `$XDG_CONFIG_HOME`)
pub fn config_dir() -> Option<std::path::PathBuf> {
    directories::ProjectDirs::from("", "", "local-tool-bridge")
        .map(|dirs| dirs.config_dir().to_path_buf())
}

/// The path of the persisted policy document.
pub fn policy_path() -> Option<std::path::PathBuf> {
    config_dir().map(|dir| dir.join("policy.json"))
}

/// The path of the audit log.
pub fn audit_path() -> Option<std::path::PathBuf> {
    config_dir().map(|dir| dir.join("audit.jsonl"))
}
