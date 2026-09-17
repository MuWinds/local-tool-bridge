//! External MCP server management.
//!
//! The bridge can launch local stdio MCP servers from `mcp.json`, discover their
//! tools, and expose those tools through the same Dispatcher/policy/audit path as
//! built-in tools. The child process and its JSON-RPC pipes are kept alive by the
//! proxy tool itself.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use ltb_core::error::{BridgeError, Result};
use ltb_core::tools::{
    ContentBlock, DefaultEffect, ObjectSchema, Tool, ToolContext, ToolDescriptor, ToolOutput,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

/// Persisted MCP server configuration. This follows the familiar `mcpServers`
/// shape used by MCP clients, with an `enabled` switch and a default bridge policy.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpConfig {
    #[serde(rename = "mcpServers", default)]
    pub servers: BTreeMap<String, McpServerConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_effect")]
    pub default_effect: DefaultEffect,
}

fn default_true() -> bool {
    true
}
fn default_effect() -> DefaultEffect {
    DefaultEffect::Ask
}

/// Loads `mcp.json` from the per-user configuration directory. Missing files are
/// normal and produce an empty configuration.
pub fn load_config() -> McpConfig {
    let Some(path) = config_path() else {
        return McpConfig::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(config) => config,
            Err(error) => {
                tracing::error!(
                    path = %path.display(),
                    %error,
                    "MCP config is malformed; using an empty configuration"
                );
                McpConfig::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => McpConfig::default(),
        Err(error) => {
            tracing::error!(
                path = %path.display(),
                %error,
                "failed to read MCP config; using an empty configuration"
            );
            McpConfig::default()
        }
    }
}

/// Saves the bridge's upstream MCP server configuration and returns its path.
pub fn save_config(config: &McpConfig) -> Result<PathBuf> {
    let path = config_path().ok_or_else(|| {
        BridgeError::internal("No per-user config directory is available on this system")
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| BridgeError::from_io("Failed to create the config directory", e))?;
    }
    let text = serde_json::to_string_pretty(config)
        .map_err(|e| BridgeError::internal(format!("Failed to serialise MCP config: {e}")))?;
    std::fs::write(&path, text)
        .map_err(|e| BridgeError::from_io("Failed to write MCP config", e))?;
    Ok(path)
}

pub fn config_path() -> Option<PathBuf> {
    ltb_core::config_dir().map(|dir| dir.join("mcp.json"))
}

/// Generates a client-side MCP configuration pointing back at this bridge.
pub fn save_client_config(address: &str, secret: &str) -> Result<PathBuf> {
    let path = ltb_core::config_dir()
        .ok_or_else(|| {
            BridgeError::internal("No per-user config directory is available on this system")
        })?
        .join("mcp-client.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| BridgeError::from_io("Failed to create the config directory", e))?;
    }
    let value = json!({
        "mcpServers": {
            "local-tool-bridge": {
                "url": format!("http://{address}/mcp"),
                "headers": { "x-dlb-secret": secret }
            }
        }
    });
    let text = serde_json::to_string_pretty(&value).map_err(|e| {
        BridgeError::internal(format!("Failed to serialise client MCP config: {e}"))
    })?;
    std::fs::write(&path, text)
        .map_err(|e| BridgeError::from_io("Failed to write client MCP config", e))?;
    Ok(path)
}

/// Launches enabled stdio servers and registers all discovered tools.
/// Failed servers are logged and skipped so one broken package does not stop the
/// built-in bridge from starting.
pub async fn load_into_registry(registry: &mut ltb_core::tools::ToolRegistry) {
    let config = load_config();
    for (server_name, server) in config.servers {
        if !server.enabled {
            continue;
        }
        match McpConnection::start(&server_name, &server).await {
            Ok((connection, tools)) => {
                let connection = Arc::new(connection);
                let count = tools.len();
                for tool in tools {
                    let descriptor = proxy_descriptor(&server_name, &tool, server.default_effect);
                    registry.register(Arc::new(McpProxyTool {
                        descriptor,
                        connection: connection.clone(),
                        remote_name: tool.name,
                    }));
                }
                tracing::info!(server = %server_name, tools = count, "loaded external MCP server");
            }
            Err(error) => {
                tracing::error!(server = %server_name, %error, "failed to load external MCP server")
            }
        }
    }
}

#[derive(Debug, Clone)]
struct RemoteTool {
    name: String,
    description: String,
    input_schema: Value,
}

struct McpConnection {
    _child: Child,
    io: Mutex<McpIo>,
}

struct McpIo {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl McpConnection {
    async fn start(name: &str, config: &McpServerConfig) -> Result<(Self, Vec<RemoteTool>)> {
        let mut command = Command::new(&config.command);
        command
            .args(&config.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit());
        for (key, value) in &config.env {
            command.env(key, value);
        }
        if let Some(cwd) = &config.cwd {
            command.current_dir(cwd);
        }

        let mut child = command.spawn().map_err(|e| {
            BridgeError::from_io(&format!("Failed to start MCP server `{name}`"), e)
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BridgeError::internal("MCP server stdin was not available"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BridgeError::internal("MCP server stdout was not available"))?;
        let connection = Self {
            _child: child,
            io: Mutex::new(McpIo {
                stdin,
                stdout: BufReader::new(stdout),
                next_id: 1,
            }),
        };

        let initialize = connection.request("initialize", json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "local-tool-bridge", "version": env!("CARGO_PKG_VERSION") }
        })).await?;
        if initialize.get("error").is_some() {
            return Err(BridgeError::internal(format!(
                "MCP server `{name}` rejected initialize: {initialize}"
            )));
        }
        connection
            .notify("notifications/initialized", json!({}))
            .await?;

        let listed = connection.request("tools/list", json!({})).await?;
        if let Some(error) = listed.get("error") {
            return Err(BridgeError::internal(format!(
                "MCP server `{name}` tools/list failed: {error}"
            )));
        }
        let tools = listed
            .get("result")
            .and_then(|v| v.get("tools"))
            .and_then(Value::as_array)
            .ok_or_else(|| {
                BridgeError::internal(format!(
                    "MCP server `{name}` returned an invalid tools/list response"
                ))
            })?
            .iter()
            .filter_map(|tool| {
                Some(RemoteTool {
                    name: tool.get("name")?.as_str()?.to_string(),
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("External MCP tool")
                        .to_string(),
                    input_schema: tool
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({"type":"object"})),
                })
            })
            .collect();
        Ok((connection, tools))
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let mut io = self.io.lock().await;
        let message = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        io.stdin
            .write_all(message.to_string().as_bytes())
            .await
            .map_err(|e| BridgeError::from_io("Failed to write to MCP server", e))?;
        io.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| BridgeError::from_io("Failed to write to MCP server", e))?;
        io.stdin
            .flush()
            .await
            .map_err(|e| BridgeError::from_io("Failed to flush MCP server stdin", e))?;
        Ok(())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let mut io = self.io.lock().await;
        let id = io.next_id;
        io.next_id += 1;
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        io.stdin
            .write_all(message.to_string().as_bytes())
            .await
            .map_err(|e| BridgeError::from_io("Failed to write to MCP server", e))?;
        io.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| BridgeError::from_io("Failed to write to MCP server", e))?;
        io.stdin
            .flush()
            .await
            .map_err(|e| BridgeError::from_io("Failed to flush MCP server stdin", e))?;

        let mut line = String::new();
        loop {
            line.clear();
            let bytes = io
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|e| BridgeError::from_io("Failed to read from MCP server", e))?;
            if bytes == 0 {
                return Err(BridgeError::internal("MCP server closed stdout"));
            }
            let value: Value = match serde_json::from_str(line.trim()) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                return Ok(value);
            }
        }
    }
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn proxy_name(server: &str, tool: &str) -> String {
    let mut name = format!("mcp_{}_{}", safe_component(server), safe_component(tool));
    name.truncate(64);
    name
}

fn proxy_descriptor(server: &str, tool: &RemoteTool, effect: DefaultEffect) -> ToolDescriptor {
    let input_schema =
        serde_json::from_value::<ObjectSchema>(tool.input_schema.clone()).unwrap_or(ObjectSchema {
            schema_type: "object".into(),
            properties: BTreeMap::new(),
            required: Vec::new(),
        });
    ToolDescriptor {
        name: proxy_name(server, &tool.name),
        summary: format!("MCP `{server}`: {}", tool.name),
        description: tool.description.clone(),
        category: format!("mcp:{server}"),
        input_schema,
        mutating: effect != DefaultEffect::Allow,
        default_effect: effect,
        latency_hint: "network".into(),
    }
}

struct McpProxyTool {
    descriptor: ToolDescriptor,
    connection: Arc<McpConnection>,
    remote_name: String,
}

#[async_trait::async_trait]
impl Tool for McpProxyTool {
    fn descriptor(&self) -> ToolDescriptor {
        self.descriptor.clone()
    }

    async fn execute(&self, arguments: Value, _context: &ToolContext<'_>) -> Result<ToolOutput> {
        let response = self
            .connection
            .request(
                "tools/call",
                json!({
                    "name": self.remote_name,
                    "arguments": arguments
                }),
            )
            .await?;

        if let Some(error) = response.get("error") {
            return Ok(ToolOutput::error(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("External MCP tool failed"),
            ));
        }
        let result = response.get("result").cloned().unwrap_or_else(|| json!({}));
        let is_error = result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let content = result
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let blocks = content
            .into_iter()
            .map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    ContentBlock::text(item.get("text").and_then(Value::as_str).unwrap_or(""))
                } else {
                    ContentBlock::text(item.to_string())
                }
            })
            .collect::<Vec<_>>();
        Ok(ToolOutput {
            content: if blocks.is_empty() {
                vec![ContentBlock::text(result.to_string())]
            } else {
                blocks
            },
            is_error,
            truncated: false,
            original_bytes: None,
            duration_ms: None,
        })
    }
}
