//! Optional Direct Remote MCP configuration.
//!
//! The existing loopback MCP endpoint and Secure MCP Tunnel remain the default.
//! This module adds an opt-in second listener intended to sit behind a TLS
//! reverse proxy such as Caddy. It uses a dedicated static Bearer token instead
//! of reusing the bridge's loopback secret.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use rand::RngCore;
use serde::{Deserialize, Serialize};

use ltb_core::{BridgeError, Result};

const CONFIG_FILE: &str = "direct-mcp.json";
const TOKEN_FILE: &str = "direct-mcp-token";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DirectMcpConfig {
    /// Whether the GUI should start the direct listener on launch.
    pub enabled: bool,
    /// Address to bind. Keep this at 127.0.0.1 when using a local reverse proxy.
    pub bind: String,
    /// Dedicated direct-MCP port. Chosen outside the GUI's loopback probe range.
    pub port: u16,
    /// Optional public URL shown in the UI/documentation; not used for routing.
    pub public_base_url: String,
    /// Optional token file override. Empty means the per-user default.
    pub token_file: String,
}

impl Default for DirectMcpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: Ipv4Addr::LOCALHOST.to_string(),
            port: 8792,
            public_base_url: String::new(),
            token_file: String::new(),
        }
    }
}

impl DirectMcpConfig {
    pub fn socket_addr(&self) -> Result<SocketAddr> {
        let ip = self.bind.trim().parse::<IpAddr>().map_err(|error| {
            BridgeError::invalid_params(format!(
                "Invalid Direct MCP bind address '{}': {error}",
                self.bind
            ))
        })?;
        Ok(SocketAddr::new(ip, self.port))
    }
}

pub fn config_path() -> Option<PathBuf> {
    ltb_core::config_dir().map(|dir| dir.join(CONFIG_FILE))
}

pub fn default_token_path() -> Option<PathBuf> {
    ltb_core::config_dir().map(|dir| dir.join(TOKEN_FILE))
}

pub fn token_path(config: &DirectMcpConfig) -> Option<PathBuf> {
    let configured = config.token_file.trim();
    if configured.is_empty() {
        default_token_path()
    } else {
        Some(PathBuf::from(configured))
    }
}

pub fn load_config() -> DirectMcpConfig {
    let Some(path) = config_path() else {
        return DirectMcpConfig::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
            tracing::error!(
                path = %path.display(),
                %error,
                "Direct MCP config is malformed; using defaults"
            );
            DirectMcpConfig::default()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DirectMcpConfig::default(),
        Err(error) => {
            tracing::error!(
                path = %path.display(),
                %error,
                "Failed to read Direct MCP config; using defaults"
            );
            DirectMcpConfig::default()
        }
    }
}

pub fn save_config(config: &DirectMcpConfig) -> Result<PathBuf> {
    let path = config_path().ok_or_else(|| {
        BridgeError::internal("No per-user config directory is available on this system")
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| BridgeError::from_io("Failed to create the config directory", e))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| {
        BridgeError::internal(format!("Failed to serialise Direct MCP config: {e}"))
    })?;
    std::fs::write(&path, json)
        .map_err(|e| BridgeError::from_io("Failed to write Direct MCP config", e))?;
    Ok(path)
}

pub fn load_or_create_token(config: &DirectMcpConfig) -> std::io::Result<String> {
    let Some(path) = token_path(config) else {
        return Ok(generate_token());
    };
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let token = generate_token();
    std::fs::write(&path, &token)?;
    restrict_permissions(&path)?;
    Ok(token)
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_fail_closed_and_reverse_proxy_friendly() {
        let config = DirectMcpConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.bind, "127.0.0.1");
        assert_eq!(config.port, 8792);
        assert!(config.public_base_url.is_empty());
    }

    #[test]
    fn socket_addr_parses_ipv4_and_ipv6() {
        let mut config = DirectMcpConfig {
            bind: "::1".into(),
            ..Default::default()
        };
        assert_eq!(
            config.socket_addr().unwrap(),
            "[::1]:8792".parse::<SocketAddr>().unwrap()
        );
        config.bind = "not-an-ip".into();
        assert!(config.socket_addr().is_err());
    }
}
