//! `http.request` — reach the network on the model's behalf.
//!
//! Two independent gates protect the local network:
//!
//! 1. **Host allowlist** — only hosts the user listed are reachable at all.
//! 2. **Private-range block** — loopback, RFC1918, link-local, and `.local`
//!    targets are refused unless the user explicitly opted in. Without this, a
//!    prompt injection in a fetched page could pivot to a cloud metadata
//!    endpoint or a LAN admin panel.
//!
//! Redirects are followed manually so each hop is re-checked: a public URL that
//! 302s to `http://169.254.169.254/` must not slip through.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::{
    Tool, ToolContext, ToolDescriptor, ToolOutput, clamp_u64, optional_str, optional_u64,
    required_str,
};
use crate::error::{BridgeError, Result};
use crate::policy::{host_matches, is_private_host};

/// Methods that are safe to retry and never carry a body.
const SAFE_METHODS: &[&str] = &["GET", "HEAD", "OPTIONS"];

/// How many redirects to follow before giving up.
const MAX_REDIRECTS: usize = 5;

/// `http.request`
pub struct Request;

#[async_trait::async_trait]
impl Tool for Request {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "http.request".into(),
            summary: "Make an HTTP request to an allowlisted host".into(),
            description: "Performs an HTTP request and returns status, headers, and body. Only \
                          hosts on the user's allowlist are reachable; loopback and private \
                          ranges are blocked by default to prevent the model from reaching \
                          internal services."
                .into(),
            category: "http".into(),
            mutating: true,
            default_effect: super::DefaultEffect::Ask,
            latency_hint: "slow".into(),
            input_schema: super::ObjectSchema {
                schema_type: "object".into(),
                properties: serde_json::from_value(json!({
                    "url": { "type": "string", "description": "Absolute http(s) URL" },
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
                        "default": "GET",
                    },
                    "headers": { "type": "object", "description": "Request headers" },
                    "body": {
                        "type": "string",
                        "description": "Request body for non-GET methods",
                    },
                    "timeoutMs": {
                        "type": "integer",
                        "minimum": 100,
                        "maximum": 120000,
                        "default": 30000,
                    },
                    "maxBytes": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 10485760,
                        "default": 1048576,
                    },
                }))
                .expect("schema must be an object"),
                required: vec!["url".into()],
            },
        }
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        let started = Instant::now();
        let raw_url = required_str(&arguments, "url")?;
        let method = optional_str(&arguments, "method")
            .unwrap_or_else(|| "GET".into())
            .to_uppercase();
        let timeout_ms = clamp_u64(optional_u64(&arguments, "timeoutMs", 30_000), 100, 120_000);
        let max_bytes = clamp_u64(
            optional_u64(&arguments, "maxBytes", 1_048_576),
            1,
            10_485_760,
        ) as usize;

        let url = url::Url::parse(&raw_url)
            .map_err(|error| BridgeError::invalid_params(format!("Invalid URL: {error}")))?;

        if !matches!(url.scheme(), "http" | "https") {
            return Err(BridgeError::invalid_params(format!(
                "Unsupported scheme `{}`; only http and https are allowed",
                url.scheme()
            )));
        }

        self.assert_host_allowed(&url, context)?;

        let client = reqwest::Client::builder()
            // Redirects are resolved by hand below so every hop is re-validated.
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(timeout_ms))
            .user_agent(concat!("local-tool-bridge/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| {
                BridgeError::internal(format!("Failed to build HTTP client: {error}"))
            })?;

        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(map) = arguments.get("headers").and_then(Value::as_object) {
            for (key, value) in map {
                let Some(value) = value.as_str() else {
                    continue;
                };
                let name =
                    reqwest::header::HeaderName::from_bytes(key.as_bytes()).map_err(|error| {
                        BridgeError::invalid_params(format!("Invalid header `{key}`: {error}"))
                    })?;
                let parsed = reqwest::header::HeaderValue::from_str(value).map_err(|error| {
                    BridgeError::invalid_params(format!("Invalid value for `{key}`: {error}"))
                })?;
                headers.insert(name, parsed);
            }
        }

        let body = optional_str(&arguments, "body");
        let mut current = url;
        let mut redirects = 0usize;
        let mut history: Vec<String> = Vec::new();

        let response = loop {
            let mut request = client.request(
                reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| {
                    BridgeError::invalid_params(format!("Invalid method: {error}"))
                })?,
                current.clone(),
            );
            request = request.headers(headers.clone());
            if let Some(body) = &body {
                if !SAFE_METHODS.contains(&method.as_str()) {
                    request = request.body(body.clone());
                }
            }

            let response = request.send().await.map_err(|error| {
                BridgeError::new(
                    crate::error::code::INTERNAL_ERROR,
                    format!("Request failed: {error}"),
                )
            })?;

            let status = response.status();
            let is_redirect = status.is_redirection();

            if !is_redirect {
                break response;
            }

            let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
                break response;
            };
            let location = location.to_str().map_err(|_| {
                BridgeError::internal("Redirect Location header is not valid UTF-8")
            })?;

            redirects += 1;
            if redirects > MAX_REDIRECTS {
                return Err(BridgeError::new(
                    crate::error::code::TOOL_TIMEOUT,
                    format!("Exceeded {MAX_REDIRECTS} redirects starting at {raw_url}"),
                ));
            }

            let next = current.join(location).map_err(|error| {
                BridgeError::invalid_params(format!("Invalid redirect target: {error}"))
            })?;

            // Re-validate every hop. This is the check that stops a public URL
            // from redirecting into the private network.
            self.assert_host_allowed(&next, context)?;
            history.push(next.to_string());
            current = next;
        };

        let status = response.status();
        let final_url = response.url().clone();

        let mut header_lines: Vec<String> = Vec::new();
        for (name, value) in response.headers() {
            let value = value.to_str().unwrap_or("<non-UTF-8>");
            header_lines.push(format!("{name}: {value}"));
        }

        let bytes = response.bytes().await.map_err(|error| {
            BridgeError::internal(format!("Failed to read response body: {error}"))
        })?;

        let total_bytes = bytes.len();
        let clipped = &bytes[..total_bytes.min(max_bytes)];
        let body_text = String::from_utf8_lossy(clipped).to_string();

        let mut output = String::new();
        output.push_str(&format!("{} {}\n", method, final_url));
        output.push_str(&format!(
            "status: {} {}\n",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
        if !history.is_empty() {
            output.push_str(&format!("redirects: {}\n", history.join(" -> ")));
        }
        output.push_str("\n--- headers ---\n");
        output.push_str(&header_lines.join("\n"));
        output.push_str("\n\n--- body ---\n");
        output.push_str(&body_text);

        Ok(ToolOutput {
            content: vec![super::ContentBlock::text(output)],
            // An HTTP error status is information, not a bridge failure.
            is_error: false,
            truncated: total_bytes > max_bytes,
            original_bytes: Some(total_bytes),
            duration_ms: Some(started.elapsed().as_millis() as u64),
        })
    }
}

impl Request {
    /// Enforces the host allowlist and the private-range policy for one URL.
    fn assert_host_allowed(&self, url: &url::Url, context: &ToolContext<'_>) -> Result<()> {
        let host = url
            .host_str()
            .ok_or_else(|| BridgeError::invalid_params("URL has no host"))?
            .to_string();

        if is_private_host(&host) && !context.policy.allow_private_network() {
            return Err(BridgeError::host_not_allowed(format!(
                "`{host}` is a loopback, private, or local-network address; enable \
                 `allowPrivateNetwork` in the bridge settings to reach it"
            )));
        }

        let allowed = context.policy.allowed_hosts();
        if allowed.is_empty() {
            return Err(BridgeError::host_not_allowed(
                "No hosts are allowlisted; add one in the bridge settings before making \
                 HTTP requests",
            ));
        }

        if allowed.iter().any(|pattern| host_matches(pattern, &host)) {
            return Ok(());
        }

        Err(
            BridgeError::host_not_allowed(format!("`{host}` is not on the allowlist")).with_data(
                json!({
                    "host": host,
                    "allowedHosts": allowed,
                }),
            ),
        )
    }
}
