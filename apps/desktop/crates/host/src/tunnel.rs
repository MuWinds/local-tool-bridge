//! Native Rust implementation of the core OpenAI Secure MCP Tunnel client.
//!
//! This deliberately implements the language-independent tunnel wire contract,
//! rather than embedding or launching the Go `tunnel-client`.  The bridge only
//! needs the core customer-side path:
//!
//!     OpenAI control plane
//!          │ GET /v1/tunnels/{id}/poll
//!          ▼
//!     Rust tunnel runtime
//!          │ POST /mcp / DELETE /mcp
//!          ▼
//!     local-tool-bridge MCP dispatcher
//!
//! The protocol is documented by OpenAI in `docs/protocol.md` and
//! `docs/openapi.json`.  This implementation intentionally does not copy the
//! unrelated admin CLI, bundled Cloudflare runtime, Harpoon, or stdio-child
//! machinery from the reference client.  Those are separate deployment
//! features and are not required for this bridge's HTTP MCP binding.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinHandle;
use uuid::Uuid;

use ltb_core::error::{BridgeError, Result};

const WIRE_PROTOCOL_VERSION: &str = "2026-08-25";
const CLIENT_NAME: &str = "local-tool-bridge-rust";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_CONTROL_PLANE: &str = "https://api.openai.com";
const DEFAULT_POLL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_POLL_BATCH: u32 = 25;
const MAX_CONCURRENCY: usize = 10;
const MAX_BACKOFF: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub tunnel_id: String,
    #[serde(default)]
    pub api_key_file: String,
    #[serde(default = "default_control_plane")]
    pub control_plane_base_url: String,
    #[serde(default = "default_poll_timeout_string")]
    pub poll_timeout: String,
    #[serde(default = "default_wait")]
    pub startup_wait_timeout: String,
    #[serde(default)]
    pub max_concurrency: Option<usize>,
}

fn default_control_plane() -> String {
    DEFAULT_CONTROL_PLANE.into()
}
fn default_poll_timeout_string() -> String {
    "15s".into()
}
fn default_wait() -> String {
    "60s".into()
}

impl Default for TunnelConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            tunnel_id: String::new(),
            api_key_file: String::new(),
            control_plane_base_url: default_control_plane(),
            poll_timeout: default_poll_timeout_string(),
            startup_wait_timeout: default_wait(),
            max_concurrency: None,
        }
    }
}

pub fn config_path() -> Option<PathBuf> {
    ltb_core::config_dir().map(|dir| dir.join("tunnel.json"))
}

pub fn default_api_key_path() -> Option<PathBuf> {
    ltb_core::config_dir().map(|dir| dir.join("tunnel-api-key"))
}

pub fn load_config() -> TunnelConfig {
    let Some(path) = config_path() else {
        return TunnelConfig::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
            tracing::error!(path = %path.display(), %error, "Secure MCP Tunnel config is malformed; using defaults");
            TunnelConfig::default()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => TunnelConfig::default(),
        Err(error) => {
            tracing::error!(path = %path.display(), %error, "failed to read Secure MCP Tunnel config; using defaults");
            TunnelConfig::default()
        }
    }
}

pub fn save_config(config: &TunnelConfig) -> Result<PathBuf> {
    let path = config_path().ok_or_else(|| {
        BridgeError::internal("No per-user config directory is available on this system")
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| BridgeError::from_io("Failed to create the config directory", e))?;
    }
    let text = serde_json::to_string_pretty(config)
        .map_err(|e| BridgeError::internal(format!("Failed to serialise tunnel config: {e}")))?;
    std::fs::write(&path, text)
        .map_err(|e| BridgeError::from_io("Failed to write tunnel config", e))?;
    Ok(path)
}

pub fn save_api_key(value: &str) -> Result<PathBuf> {
    let path = default_api_key_path().ok_or_else(|| {
        BridgeError::internal("No per-user config directory is available on this system")
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| BridgeError::from_io("Failed to create the config directory", e))?;
    }
    std::fs::write(&path, value.trim())
        .map_err(|e| BridgeError::from_io("Failed to write tunnel API key", e))?;
    restrict_permissions(&path)
        .map_err(|e| BridgeError::from_io("Failed to restrict tunnel API key permissions", e))?;
    Ok(path)
}

fn read_secret(path: &Path, label: &str) -> Result<String> {
    let value = std::fs::read_to_string(path)
        .map_err(|e| BridgeError::from_io(&format!("Failed to read {label}"), e))?;
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(BridgeError::internal(format!("{label} is empty")));
    }
    Ok(value)
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PollEnvelope {
    #[serde(default)]
    commands: Vec<TunnelCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TunnelCommand {
    request_id: String,
    shard_token: String,
    command_type: String,
    #[serde(default = "default_channel")]
    channel: String,
    #[serde(default)]
    headers: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    jsonrpc: Option<Value>,
    #[serde(default)]
    response_timeout: Option<String>,
}

fn default_channel() -> String {
    "main".into()
}

#[derive(Debug, Serialize)]
struct TunnelResponse {
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resp_json: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resp_headers: Option<BTreeMap<String, Vec<String>>>,
    resp_code: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    resp_type: Option<String>,
}

pub struct TunnelProcess {
    stop_tx: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl TunnelProcess {
    /// Start the Rust tunnel runtime. `mcp_url` is the local Streamable HTTP
    /// endpoint and `bridge_secret_path` is read only when the runtime starts.
    pub async fn start(
        config: &TunnelConfig,
        mcp_url: &str,
        bridge_secret_path: &Path,
    ) -> Result<Self> {
        if config.tunnel_id.trim().is_empty() {
            return Err(BridgeError::internal(
                "Secure MCP Tunnel is enabled but tunnel_id is empty",
            ));
        }

        let api_key_path = if config.api_key_file.trim().is_empty() {
            default_api_key_path().ok_or_else(|| {
                BridgeError::internal("No default tunnel API key path is available")
            })?
        } else {
            PathBuf::from(config.api_key_file.trim())
        };
        let api_key = read_secret(&api_key_path, "tunnel API key")?;
        let bridge_secret = read_secret(bridge_secret_path, "bridge secret")?;
        let poll_timeout = parse_duration(&config.poll_timeout).unwrap_or(DEFAULT_POLL_TIMEOUT);
        let startup_wait =
            parse_duration(&config.startup_wait_timeout).unwrap_or(Duration::from_secs(60));
        let concurrency = config
            .max_concurrency
            .unwrap_or(MAX_CONCURRENCY)
            .clamp(1, 100);

        let base = config
            .control_plane_base_url
            .trim_end_matches('/')
            .to_string();
        let client = Client::builder()
            .user_agent(format!("{CLIENT_NAME}/{CLIENT_VERSION}"))
            .build()
            .map_err(|e| {
                BridgeError::internal(format!("Failed to build tunnel HTTP client: {e}"))
            })?;
        let tunnel = Arc::new(RustTunnel {
            client,
            base_url: base,
            tunnel_id: config.tunnel_id.clone(),
            api_key,
            mcp_url: mcp_url.to_string(),
            bridge_secret,
            concurrency: Arc::new(Semaphore::new(concurrency)),
            poll_timeout,
            instance_id: format!("ltb-{}", Uuid::new_v4()),
        });
        tunnel.wait_for_mcp(startup_wait).await?;
        let (stop_tx, stop_rx) = watch::channel(false);
        let runtime = tunnel.clone();
        let task = tokio::spawn(async move {
            runtime.run(stop_rx).await;
        });

        tracing::info!(tunnel_id = %config.tunnel_id, mcp_url, "native Rust Secure MCP Tunnel client started");
        Ok(Self {
            stop_tx,
            task: Some(task),
        })
    }

    pub async fn stop(&mut self) {
        let _ = self.stop_tx.send(true);
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
    }
}

struct RustTunnel {
    client: Client,
    base_url: String,
    tunnel_id: String,
    api_key: String,
    mcp_url: String,
    bridge_secret: String,
    concurrency: Arc<Semaphore>,
    poll_timeout: Duration,
    instance_id: String,
}

impl RustTunnel {
    fn common_headers(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let auth = format!("Bearer {}", self.api_key);
        request = request
            .header(AUTHORIZATION, auth)
            .header("X-Tunnel-Client-Name", CLIENT_NAME)
            .header("X-Tunnel-Client-Version", CLIENT_VERSION)
            .header(
                "X-Tunnel-Client-Wire-Protocol-Version",
                WIRE_PROTOCOL_VERSION,
            )
            .header("X-Tunnel-Client-Instance-Id", self.instance_id());
        let server_info = r#"{"version":1,"channels":[{"name":"main"}]}"#;
        request.header("X-Tunnel-MCP-Server-Info", server_info)
    }

    fn instance_id(&self) -> String {
        self.instance_id.clone()
    }

    async fn wait_for_mcp(&self, timeout: Duration) -> Result<()> {
        let health_url = self.mcp_url.trim_end_matches("/mcp").to_string() + "/health";
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(BridgeError::internal(
                    "Timed out waiting for local MCP server",
                ));
            }
            match self.client.get(&health_url).send().await {
                Ok(response) if response.status().is_success() => return Ok(()),
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }

    async fn run(self: Arc<Self>, mut stop: watch::Receiver<bool>) {
        let mut backoff = Duration::from_millis(250);
        loop {
            if *stop.borrow() {
                break;
            }
            match self.poll_once().await {
                Ok(Some(commands)) => {
                    backoff = Duration::from_millis(250);
                    for command in commands {
                        let tunnel = self.clone();
                        let permit = tunnel.concurrency.clone().acquire_owned().await;
                        let Ok(permit) = permit else { break };
                        tokio::spawn(async move {
                            let _permit = permit;
                            if let Err(error) = tunnel.handle_command(command).await {
                                tracing::warn!(%error, "Secure MCP Tunnel command failed");
                            }
                        });
                    }
                }
                Ok(None) => {
                    backoff = Duration::from_millis(250);
                }
                Err(error) => {
                    tracing::warn!(%error, backoff_ms = backoff.as_millis(), "Secure MCP Tunnel poll failed");
                    let _ = tokio::time::timeout(backoff, stop.changed()).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
        tracing::info!("native Rust Secure MCP Tunnel client stopped");
    }

    async fn poll_once(&self) -> Result<Option<Vec<TunnelCommand>>> {
        let url = format!("{}/v1/tunnels/{}/poll", self.base_url, self.tunnel_id);
        let timeout_ms = self.poll_timeout.as_millis().clamp(1, 120_000) as u32;
        let request = self
            .client
            .get(url)
            .query(&[("limit", MAX_POLL_BATCH), ("timeout_ms", timeout_ms)]);
        let response =
            self.common_headers(request).send().await.map_err(|e| {
                BridgeError::internal(format!("Tunnel control-plane poll failed: {e}"))
            })?;

        match response.status() {
            StatusCode::NO_CONTENT => Ok(None),
            StatusCode::OK => {
                let envelope = response.json::<PollEnvelope>().await.map_err(|e| {
                    BridgeError::internal(format!("Invalid tunnel poll response: {e}"))
                })?;
                Ok(Some(envelope.commands))
            }
            status => Err(control_plane_error(status, response).await),
        }
    }

    async fn handle_command(&self, command: TunnelCommand) -> Result<()> {
        let timeout = command.response_timeout.as_deref().and_then(parse_duration);
        if matches!(timeout, Some(value) if value.is_zero()) {
            return Ok(());
        }

        match command.command_type.as_str() {
            "jsonrpc" => self.forward_jsonrpc(command, timeout).await,
            "session_termination" => self.terminate_session(command, timeout).await,
            other => {
                tracing::warn!(request_id = %command.request_id, command_type = other, "unsupported Secure MCP Tunnel command type");
                Ok(())
            }
        }
    }

    async fn forward_jsonrpc(
        &self,
        command: TunnelCommand,
        timeout: Option<Duration>,
    ) -> Result<()> {
        let payload = command.jsonrpc.clone().ok_or_else(|| {
            BridgeError::internal("Tunnel jsonrpc command has no jsonrpc payload")
        })?;
        let request_id = command.request_id.clone();
        let channel = command.channel.clone();
        let is_notification = payload.get("id").is_none();

        let mut request = self
            .client
            .request(Method::POST, &self.mcp_url)
            .header(CONTENT_TYPE, "application/json");
        request = request.header("x-dlb-secret", &self.bridge_secret);
        request = apply_command_headers(request, &command.headers);
        request = self.common_headers_to_mcp(request);
        let future = request.json(&payload).send();
        let response = if let Some(timeout) = timeout {
            tokio::time::timeout(timeout, future)
                .await
                .map_err(|_| BridgeError::internal("MCP request exceeded tunnel response_timeout"))?
                .map_err(|e| BridgeError::internal(format!("MCP request failed: {e}")))?
        } else {
            future
                .await
                .map_err(|e| BridgeError::internal(format!("MCP request failed: {e}")))?
        };

        let status = response.status().as_u16();
        let headers = response_headers(&response.headers());
        let bytes = response
            .bytes()
            .await
            .map_err(|e| BridgeError::internal(format!("Failed to read MCP response: {e}")))?;
        let json_body = serde_json::from_slice::<Value>(&bytes).ok();

        let result = if is_notification {
            TunnelResponse {
                request_id,
                channel: Some(channel),
                resp_json: None,
                resp_headers: Some(headers),
                resp_code: status,
                resp_type: Some("notify_ack".into()),
            }
        } else {
            TunnelResponse {
                request_id,
                channel: Some(channel),
                resp_json: json_body,
                resp_headers: Some(headers),
                resp_code: status,
                resp_type: Some("jsonrpc_response".into()),
            }
        };
        self.post_response(&command.shard_token, result, timeout)
            .await
    }

    async fn terminate_session(
        &self,
        command: TunnelCommand,
        timeout: Option<Duration>,
    ) -> Result<()> {
        let session = command
            .headers
            .get("Mcp-Session-Id")
            .and_then(|v| v.first())
            .cloned();
        let mut request = self
            .client
            .request(Method::DELETE, &self.mcp_url)
            .header("x-dlb-secret", &self.bridge_secret);
        if let Some(session) = session {
            request = request.header("Mcp-Session-Id", session);
        }
        request = self.common_headers_to_mcp(request);
        let future = request.send();
        let response = if let Some(timeout) = timeout {
            tokio::time::timeout(timeout, future)
                .await
                .map_err(|_| {
                    BridgeError::internal(
                        "MCP session termination exceeded tunnel response_timeout",
                    )
                })?
                .map_err(|e| {
                    BridgeError::internal(format!("MCP session termination failed: {e}"))
                })?
        } else {
            future.await.map_err(|e| {
                BridgeError::internal(format!("MCP session termination failed: {e}"))
            })?
        };
        let result = TunnelResponse {
            request_id: command.request_id,
            channel: Some(command.channel),
            resp_json: None,
            resp_headers: Some(response_headers(response.headers())),
            resp_code: response.status().as_u16(),
            resp_type: Some("session_termination_response".into()),
        };
        self.post_response(&command.shard_token, result, timeout)
            .await
    }

    fn common_headers_to_mcp(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
    }

    async fn post_response(
        &self,
        shard_token: &str,
        response: TunnelResponse,
        timeout: Option<Duration>,
    ) -> Result<()> {
        let url = format!("{}/v1/tunnels/{}/response", self.base_url, self.tunnel_id);
        let request = self
            .common_headers(self.client.post(url))
            .header(CONTENT_TYPE, "application/json")
            .header("X-Tunnel-Shard-Token", shard_token)
            .json(&response);
        let future = request.send();
        let result = if let Some(timeout) = timeout {
            tokio::time::timeout(timeout, future)
                .await
                .map_err(|_| {
                    BridgeError::internal("Tunnel response delivery exceeded response_timeout")
                })?
                .map_err(|e| {
                    BridgeError::internal(format!("Tunnel response delivery failed: {e}"))
                })?
        } else {
            future.await.map_err(|e| {
                BridgeError::internal(format!("Tunnel response delivery failed: {e}"))
            })?
        };
        if !result.status().is_success() {
            return Err(BridgeError::internal(format!(
                "Tunnel response delivery returned HTTP {}",
                result.status()
            )));
        }
        Ok(())
    }
}

fn apply_command_headers(
    mut request: reqwest::RequestBuilder,
    headers: &BTreeMap<String, Vec<String>>,
) -> reqwest::RequestBuilder {
    const BLOCKED: &[&str] = &[
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
        "upgrade",
        "proxy-authorization",
        "proxy-authenticate",
        "x-dlb-secret",
    ];
    for (name, values) in headers {
        if BLOCKED
            .iter()
            .any(|blocked| name.eq_ignore_ascii_case(blocked))
        {
            continue;
        }
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        for value in values {
            if let Ok(value) = HeaderValue::from_str(value) {
                request = request.header(&name, value);
            }
        }
    }
    request
}

fn response_headers(headers: &HeaderMap) -> BTreeMap<String, Vec<String>> {
    const ALLOWED: &[&str] = &[
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
        "access-control-expose-headers",
        "www-authenticate",
    ];
    let mut result = BTreeMap::new();
    for name in ALLOWED {
        let values: Vec<String> = headers
            .get_all(*name)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_string))
            .collect();
        if !values.is_empty() {
            result.insert((*name).to_string(), values);
        }
    }
    result
}

async fn control_plane_error(status: StatusCode, response: reqwest::Response) -> BridgeError {
    let text = response.text().await.unwrap_or_default();
    let detail = if text.len() > 512 {
        format!("{}…", &text[..512])
    } else {
        text
    };
    BridgeError::internal(format!(
        "Secure MCP Tunnel control plane returned HTTP {status}: {detail}"
    ))
}

fn parse_duration(value: &str) -> Option<Duration> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, 'n' | 's' | 'u' | 'm' | 'h'))
    {
        return None;
    }
    let split = value.find(|c: char| !c.is_ascii_digit())?;
    let (number, unit) = value.split_at(split);
    if number.is_empty() || unit.len() != 1 {
        return None;
    }
    let number = number.parse::<u64>().ok()?;
    match unit.as_bytes()[0] {
        b'n' => Some(Duration::from_nanos(number)),
        b'u' => Some(Duration::from_micros(number)),
        b'm' => Some(Duration::from_millis(number)),
        b's' => Some(Duration::from_secs(number)),
        b'h' => number
            .checked_mul(3600)
            .and_then(|seconds| Some(Duration::from_secs(seconds))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_duration;
    use std::time::Duration;

    #[test]
    fn parses_protocol_durations() {
        assert_eq!(parse_duration("30s"), Some(Duration::from_secs(30)));
        assert_eq!(parse_duration("4500ms"), Some(Duration::from_millis(4500)));
        assert_eq!(parse_duration("1us"), Some(Duration::from_micros(1)));
        assert_eq!(parse_duration("2h"), Some(Duration::from_secs(7200)));
        assert_eq!(parse_duration("0s"), Some(Duration::ZERO));
    }

    #[test]
    fn rejects_non_contract_duration_forms() {
        assert_eq!(parse_duration("4.5s"), None);
        assert_eq!(parse_duration("1m30s"), None);
        assert_eq!(parse_duration(" 1s"), None);
        assert_eq!(parse_duration("1s "), None);
        assert_eq!(parse_duration("30d"), None);
        assert_eq!(parse_duration("30"), None);
    }
}
