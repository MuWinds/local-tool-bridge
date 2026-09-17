//! `ltb-host` — the local bridge process, as a library.

pub mod http;
pub mod mcp;
pub mod mcp_servers;
pub mod tunnel;
pub mod websocket;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use ltb_core::audit::AuditLog;
use ltb_core::dispatch::Dispatcher;
use ltb_core::policy::{Policy, PolicyEngine};
use ltb_core::tools::ToolRegistry;
use ltb_core::{audit_path, policy_path, Result};

/// Loads the policy document, falling back to the built-in default on failure.
pub fn load_policy(path: Option<&PathBuf>) -> Policy {
    let path = match path.cloned().or_else(policy_path) {
        Some(path) => path,
        None => return Policy::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Policy>(&text) {
            Ok(policy) => policy,
            Err(error) => {
                tracing::error!(path = %path.display(), %error, "policy file is malformed; falling back to defaults");
                Policy::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Policy::default(),
        Err(error) => {
            tracing::error!(path = %path.display(), %error, "failed to read policy; using defaults");
            Policy::default()
        }
    }
}

/// Persists a policy document, creating the config directory as needed.
pub fn save_policy(policy: &Policy) -> Result<PathBuf> {
    let path = policy_path().ok_or_else(|| {
        ltb_core::BridgeError::internal("No per-user config directory is available on this system")
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            ltb_core::BridgeError::from_io("Failed to create the config directory", e)
        })?;
    }
    let json = serde_json::to_string_pretty(policy)
        .map_err(|e| ltb_core::BridgeError::internal(format!("Failed to serialise policy: {e}")))?;
    std::fs::write(&path, json)
        .map_err(|e| ltb_core::BridgeError::from_io("Failed to write the policy file", e))?;
    Ok(path)
}

/// Loads the persisted bridge secret, generating one on first run.
pub fn load_or_create_secret() -> std::io::Result<String> {
    let Some(dir) = ltb_core::config_dir() else {
        return Ok(uuid::Uuid::new_v4().to_string());
    };
    let path = dir.join("secret");
    std::fs::create_dir_all(&dir)?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let secret = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    std::fs::write(&path, &secret)?;
    restrict_permissions(&path)?;
    Ok(secret)
}

#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}
#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) -> std::io::Result<()> {
    Ok(())
}

/// Builds a dispatcher from the on-disk configuration. Enabled external stdio MCP
/// servers are discovered here, before the dispatcher is shared with transports.
pub async fn build_dispatcher(
    policy_override: Option<PathBuf>,
    audit_enabled: bool,
) -> Result<Arc<Dispatcher>> {
    let policy = load_policy(policy_override.as_ref());
    let engine = PolicyEngine::new(policy)?;
    let audit = match (audit_enabled, audit_path()) {
        (true, Some(path)) => AuditLog::open(path, true).await?,
        _ => AuditLog::open(PathBuf::new(), false).await?,
    };

    let mut registry = ToolRegistry::with_builtins();
    mcp_servers::load_into_registry(&mut registry).await;
    let registry = Arc::new(registry);
    let secret = load_or_create_secret().ok();
    Dispatcher::new(registry, engine, Arc::new(audit), secret)
}

pub async fn run_websocket(
    port: u16,
    dispatcher: Arc<Dispatcher>,
    secret: String,
) -> std::io::Result<SocketAddr> {
    let listener =
        tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await?;
    let address = listener.local_addr()?;
    tokio::spawn(websocket::serve(listener, dispatcher, Arc::new(secret)));
    Ok(address)
}

pub async fn run_http(
    port: u16,
    dispatcher: Arc<Dispatcher>,
    secret: String,
) -> std::io::Result<SocketAddr> {
    let listener = http::bind(port).await?;
    let address = listener.local_addr()?;
    tokio::spawn(http::serve(listener, dispatcher, Arc::new(secret)));
    Ok(address)
}

pub async fn run_mcp(
    port: u16,
    dispatcher: Arc<Dispatcher>,
    secret: String,
) -> std::io::Result<SocketAddr> {
    let listener = mcp::bind(port).await?;
    let address = listener.local_addr()?;
    tokio::spawn(mcp::serve(listener, dispatcher, Arc::new(secret)));
    Ok(address)
}
