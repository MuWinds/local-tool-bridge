//! The MCP (Model Context Protocol) transport.
//!
//! This endpoint speaks the MCP Streamable HTTP protocol so that ChatGPT,
//! Codex, or any other MCP client can reach the local tools. The supported
//! path into it is OpenAI's Secure MCP Tunnel
//! (`openai/tunnel-client`): the tunnel daemon runs locally, long-polls the
//! OpenAI control plane for commands addressed to a tunnel, and forwards each
//! one here as MCP JSON-RPC.
//!
//! There is deliberately **no second tool implementation**: every MCP method is
//! translated onto the same [`Dispatcher`] the other transports use, so policy
//! evaluation, approval, and audit are identical no matter which frontend made
//! the call. `tools/list` is built from the registry's descriptors and
//! `tools/call` is turned into a bridge `tools.call`, then mapped back onto the
//! MCP result shape.
//!
//! ## Security
//!
//! Bound to `127.0.0.1` and gated by the same shared secret as the loopback
//! HTTP transport. Unlike that transport there is no in-band `bridge.hello`
//! handshake (the MCP protocol has no equivalent), so the secret is required on
//! **every** request, including `initialize`. The tunnel-client supplies it via
//! `MCP_EXTRA_HEADERS` (and `MCP_DISCOVERY_EXTRA_HEADERS` for its startup
//! probe); see `docs/chatgpt-mcp.md`.
//!
//! ## Protocol surface
//!
//! Implemented methods: `initialize`, `server/discover` (2026-07-28 stateless
//! discovery), `ping`, `tools/list`, `tools/call`, plus empty `resources/*`
//! and `prompts/*` answers and `notifications/initialized` /
//! `notifications/cancelled` acknowledgements. Sessions are tracked so a
//! client that follows the stateful lifecycle gets a `Mcp-Session-Id`, but a
//! request without a session id is served statelessly, which keeps the newer
//! self-contained MCP requests working. All JSON-RPC responses echo the
//! request `id`; strict clients (e.g. the official Go SDK) reject a response
//! whose id is absent or null.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{HeaderMap, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::net::TcpListener;

use ltb_core::dispatch::{Dispatcher, PeerTrust};
use ltb_core::error::code as bridge_code;
use ltb_core::rpc::{Incoming as BridgeIncoming, JsonRpcRequest, RequestId};
use ltb_core::tools::{DefaultEffect, ToolDescriptor};

/// MCP JSON-RPC error codes, as defined by the MCP specification.
mod mcp_code {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// MCP-specific: the client sent a `Mcp-Session-Id` we do not know.
    pub const SESSION_NOT_FOUND: i64 = -32001;
}

/// The single MCP endpoint.
const MCP_PATH: &str = "/mcp";

/// A health probe with no secret requirement, mirroring the HTTP transport.
const HEALTH_PATH: &str = "/health";

/// Maximum request body accepted, in bytes.
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// The header the bridge secret travels in. Same name as the loopback HTTP
/// transport, so one secret gates every transport.
const SECRET_HEADER: &str = "x-dlb-secret";

/// MCP session header, echoed from client to server after `initialize`.
const SESSION_HEADER: &str = "mcp-session-id";

/// MCP protocol version header, echoed on responses.
const PROTOCOL_HEADER: &str = "mcp-protocol-version";

/// The protocol version this server implements. The client's requested version
/// is echoed back when it supplies one; this is the fallback for empty values.
const DEFAULT_PROTOCOL_VERSION: &str = "2026-07-28";

/// Protocol versions this server can serve, newest first. Matches the
/// official Go SDK's `supportedProtocolVersions`; advertised via
/// `server/discover` so clients negotiate without a legacy round-trip.
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[
    "2026-07-28",
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
];

/// The origin recorded for every audit entry raised over MCP. The user agent
/// is appended so the audit log shows *which* client made the call.
const MCP_ORIGIN_PREFIX: &str = "mcp";

/// Shared session registry. Sessions exist so a stateful client that echoes a
/// stale `Mcp-Session-Id` (e.g. after a host restart) gets a clear error
/// instead of a silent disconnect.
struct McpState {
    sessions: Mutex<HashMap<String, ()>>,
}

impl McpState {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn insert(&self, id: String) {
        tracing::debug!(%id, "MCP session initialized");
        self.sessions
            .lock()
            .expect("session lock poisoned")
            .insert(id, ());
    }

    fn contains(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .expect("session lock poisoned")
            .contains_key(id)
    }

    fn remove(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .expect("session lock poisoned")
            .remove(id)
            .is_some()
    }
}

/// Runs the MCP server until the process exits.
pub async fn serve(
    listener: TcpListener,
    dispatcher: Arc<Dispatcher>,
    secret: Arc<String>,
) -> std::io::Result<()> {
    let state = Arc::new(McpState::new());
    let address = listener.local_addr()?;
    tracing::info!(%address, "MCP transport listening on http://{address}{MCP_PATH}");

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(error) => {
                tracing::warn!(%error, "failed to accept an MCP connection");
                continue;
            }
        };

        let dispatcher = dispatcher.clone();
        let secret = secret.clone();
        let state = state.clone();

        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let dispatcher = dispatcher.clone();
                let secret = secret.clone();
                let state = state.clone();
                async move { handle(request, dispatcher, secret, state, peer).await }
            });

            if let Err(error) = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await
            {
                tracing::debug!(%peer, %error, "MCP connection closed");
            }
        });
    }
}

/// Builds a JSON response with CORS headers, mirroring the HTTP transport.
fn json_response(status: StatusCode, body: String) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json; charset=utf-8")
        .header("cache-control", "no-store")
        .header("access-control-allow-origin", "*")
        .body(Full::new(Bytes::from(body)))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from("{}"))))
}

/// A JSON-RPC error object in the MCP shape.
fn rpc_error(code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": null, "error": { "code": code, "message": message.into() } })
}

/// Reads a header value as a String, if present and valid UTF-8.
fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// Handles one HTTP request.
async fn handle(
    request: Request<Incoming>,
    dispatcher: Arc<Dispatcher>,
    secret: Arc<String>,
    state: Arc<McpState>,
    peer: SocketAddr,
) -> Result<Response<Full<Bytes>>, Infallible> {
    // Preflight, answered before the origin/secret checks so a browser client
    // can complete the handshake.
    if request.method() == Method::OPTIONS {
        return Ok(Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header("access-control-allow-origin", "*")
            .header("access-control-allow-methods", "POST, GET, DELETE, OPTIONS")
            .header(
                "access-control-allow-headers",
                "content-type, mcp-session-id, x-dlb-secret",
            )
            .header("access-control-max-age", "600")
            .body(Full::new(Bytes::new()))
            .expect("static response must build"));
    }

    if request.uri().path() == HEALTH_PATH {
        let body = serde_json::json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
        })
        .to_string();
        return Ok(json_response(StatusCode::OK, body));
    }

    if request.uri().path() != MCP_PATH {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            rpc_error(
                mcp_code::INVALID_REQUEST,
                format!("Unknown path `{}`; use {MCP_PATH}", request.uri().path()),
            )
            .to_string(),
        ));
    }

    // Session termination is the one non-POST verb we accept.
    if request.method() == Method::DELETE {
        return handle_delete(request.headers(), &state);
    }

    if request.method() != Method::POST {
        let body = rpc_error(
            mcp_code::INVALID_REQUEST,
            "Only POST is accepted on the MCP endpoint (GET streaming is not supported)",
        )
        .to_string();
        return Ok(json_response(StatusCode::METHOD_NOT_ALLOWED, body));
    }

    // The secret gates every MCP request. There is no in-protocol handshake to
    // exempt, and the tunnel-client sends the header on every request it makes
    // (including the startup initialize probe via discovery headers).
    let provided = request
        .headers()
        .get(SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    if provided.as_deref() != Some(secret.as_str()) {
        tracing::warn!(%peer, "rejected an MCP request without the bridge secret");
        let body = rpc_error(
            mcp_code::SESSION_NOT_FOUND,
            "Missing or invalid x-dlb-secret header; set MCP_EXTRA_HEADERS on the tunnel-client",
        )
        .to_string();
        return Ok(json_response(StatusCode::UNAUTHORIZED, body));
    }

    let headers = request.headers().clone();
    let body = match request.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(error) => {
            let body = rpc_error(
                mcp_code::PARSE_ERROR,
                format!("Failed to read the request body: {error}"),
            )
            .to_string();
            return Ok(json_response(StatusCode::BAD_REQUEST, body));
        }
    };

    if body.len() > MAX_BODY_BYTES {
        let body = rpc_error(
            mcp_code::INVALID_REQUEST,
            format!("Request body exceeds the {MAX_BODY_BYTES}-byte limit"),
        )
        .to_string();
        return Ok(json_response(StatusCode::PAYLOAD_TOO_LARGE, body));
    }

    let text = String::from_utf8_lossy(&body);
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            let body = rpc_error(
                mcp_code::PARSE_ERROR,
                format!("Malformed JSON-RPC: {error}"),
            )
            .to_string();
            return Ok(json_response(StatusCode::BAD_REQUEST, body));
        }
    };

    handle_jsonrpc(value, &dispatcher, &state, &headers).await
}

/// Handles session termination.
fn handle_delete(
    headers: &HeaderMap,
    state: &Arc<McpState>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let session_id = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let removed = session_id
        .as_deref()
        .map(|id| state.remove(id))
        .unwrap_or(false);

    if removed {
        Ok(json_response(StatusCode::OK, "{}".into()))
    } else {
        Ok(json_response(
            StatusCode::NOT_FOUND,
            rpc_error(
                mcp_code::SESSION_NOT_FOUND,
                "Unknown or already-closed session",
            )
            .to_string(),
        ))
    }
}

/// Routes one decoded JSON-RPC message.
async fn handle_jsonrpc(
    value: Value,
    dispatcher: &Arc<Dispatcher>,
    state: &Arc<McpState>,
    headers: &HeaderMap,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let object = match value.as_object() {
        Some(object) => object,
        None => {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                rpc_error(
                    mcp_code::INVALID_REQUEST,
                    "MCP payload must be a JSON object",
                )
                .to_string(),
            ));
        }
    };

    let method = object.get("method").and_then(Value::as_str);

    // Notifications carry no id and never receive a JSON-RPC reply. The HTTP
    // status is the acknowledgement (202 Accepted).
    if object.contains_key("id") {
        // Stateful clients echo their session id. An id we do not know means
        // the host restarted (or the client invented one) — surface that
        // instead of silently serving from a broken session. A request with
        // *no* session id is served statelessly, which keeps the newer
        // self-contained MCP requests working.
        if let Some(session_id) = header_str(headers, SESSION_HEADER) {
            if method != Some("initialize") && !state.contains(&session_id) {
                return Ok(json_response(
                    StatusCode::OK,
                    rpc_error(
                        mcp_code::SESSION_NOT_FOUND,
                        format!("Unknown or expired session `{session_id}`; re-initialize"),
                    )
                    .to_string(),
                ));
            }
        }

        let result = route_request(method, object, dispatcher, state, headers).await;

        let request_id = object.get("id").cloned().unwrap_or(Value::Null);

        let (status, payload, session_id, protocol_version) = match result {
            Ok((reply, session_id, protocol_version)) => {
                // A success travels as a full JSON-RPC envelope: the caller
                // matches on `id` and reads `result`. Every complete result
                // carries `resultType: "complete"` (SEP-2322); OpenAI's
                // connector validation and the tunnel-client e2e suite expect
                // it on all non-initialize responses, and foreign clients
                // ignore unknown result fields.
                let result = if method == Some("initialize") {
                    reply
                } else {
                    match reply {
                        Value::Object(mut map) => {
                            map.insert(
                                "resultType".to_string(),
                                Value::String("complete".to_string()),
                            );
                            Value::Object(map)
                        }
                        other => other,
                    }
                };
                let envelope = json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": result,
                });
                (StatusCode::OK, envelope, session_id, protocol_version)
            }
            Err((code, message)) => {
                // Errors on a 200 response MUST echo the request id. Clients
                // such as the official Go SDK reject a response whose id does
                // not match (id:null counts as invalid), which surfaces as a
                // cryptic "invalid request" decode failure.
                let envelope = json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": { "code": code, "message": message },
                });
                (StatusCode::OK, envelope, None, None)
            }
        };

        let mut builder = Response::builder()
            .status(status)
            .header("content-type", "application/json; charset=utf-8");
        if let Some(session_id) = session_id {
            builder = builder.header(SESSION_HEADER, session_id);
        }
        if let Some(protocol_version) = protocol_version {
            builder = builder.header(PROTOCOL_HEADER, protocol_version);
        }

        let response = builder
            .header("cache-control", "no-store")
            .body(Full::new(Bytes::from(payload.to_string())))
            .unwrap_or_else(|_| Response::new(Full::new(Bytes::from("{}"))));
        return Ok(response);
    }

    // Notification. The MCP protocol only defines a couple; anything else is
    // still acknowledged without a reply.
    match method {
        Some("notifications/initialized") => {}
        Some("notifications/cancelled") => {}
        Some("notifications/progress") => {}
        Some(other) => {
            tracing::debug!(method = %other, "ignoring unknown MCP notification");
        }
        None => {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                rpc_error(
                    mcp_code::INVALID_REQUEST,
                    "MCP message has neither an id nor a method",
                )
                .to_string(),
            ));
        }
    }

    Ok(Response::builder()
        .status(StatusCode::ACCEPTED)
        .header("content-type", "application/json; charset=utf-8")
        .body(Full::new(Bytes::from("{}")))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from("{}")))))
}

/// Outcome of routing one MCP request: either a reply value plus optional
/// session/protocol headers, or a JSON-RPC error code and message.
type RouteOutcome = Result<(Value, Option<String>, Option<String>), (i64, String)>;

/// Dispatches one request by method name.
async fn route_request(
    method: Option<&str>,
    object: &serde_json::Map<String, Value>,
    dispatcher: &Arc<Dispatcher>,
    state: &Arc<McpState>,
    headers: &HeaderMap,
) -> RouteOutcome {
    let params = object.get("params").cloned();

    match method {
        Some("initialize") => Ok(handle_initialize(params, state, headers)),
        Some("server/discover") => Ok(handle_server_discover()),
        Some("ping") => Ok((json!({}), None, None)),
        Some("tools/list") => Ok((handle_tools_list(dispatcher), None, None)),
        Some("tools/call") => handle_tools_call(dispatcher, params, headers).await,
        // Minimal-but-present answers keep connector discovery from probing
        // further. This server exposes no resources or prompts.
        Some("resources/list") => Ok((json!({ "resources": [] }), None, None)),
        Some("resources/templates/list") => Ok((json!({ "resourceTemplates": [] }), None, None)),
        Some("prompts/list") => Ok((json!({ "prompts": [] }), None, None)),
        Some("logging/setLevel") => Ok((json!({}), None, None)),
        Some("completion/complete") => Err((
            mcp_code::INVALID_PARAMS,
            "No prompts are available for completion".into(),
        )),
        Some(other) => Err((
            mcp_code::METHOD_NOT_FOUND,
            format!("Method not found: {other}"),
        )),
        None => Err((
            mcp_code::INVALID_REQUEST,
            "MCP request is missing a method".into(),
        )),
    }
}

/// `initialize`: negotiate the protocol, create a session, and advertise what
/// this server can do.
fn handle_initialize(
    params: Option<Value>,
    state: &Arc<McpState>,
    headers: &HeaderMap,
) -> (Value, Option<String>, Option<String>) {
    let params = params.unwrap_or_else(|| json!({}));

    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_PROTOCOL_VERSION.to_string());

    // Re-initializing on an existing session refreshes it rather than leaking.
    let session_id = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    if let Some(client_info) = params.get("clientInfo") {
        tracing::debug!(client = ?client_info, "MCP client initialized");
    }
    state.insert(session_id.clone());

    let result = json!({
        "protocolVersion": requested,
        "capabilities": {
            "tools": { "listChanged": false },
            "resources": {},
            "prompts": {},
            "logging": {}
        },
        "serverInfo": {
            "name": "local-tool-bridge",
            "version": env!("CARGO_PKG_VERSION")
        },
        "instructions": concat!(
            "This server exposes local filesystem, shell, and HTTP tools through the ",
            "Local Tool Bridge. Every call is governed by a local policy and may ",
            "require human approval in the bridge window before it runs. Paths must be ",
            "absolute; on Windows prefer forward slashes (C:/Users/...) over backslashes. ",
            "The shell tool is a real command shell: think before invoking destructive commands."
        )
    });

    (result, Some(session_id), Some(requested))
}

/// `server/discover` (SEP-2575, protocol 2026-07-28): the stateless discovery
/// handshake modern clients try before the legacy `initialize`. The response
/// mirrors the official SDK's `DiscoverResult` exactly (the generic envelope
/// adds `resultType: "complete"`): a descending `supportedVersions` list, the
/// server's capabilities, and its identity in `_meta`. OpenAI's connector
/// validates this shape; a response missing any of these fields is rejected as
/// "server/discover response was invalid".
fn handle_server_discover() -> (Value, Option<String>, Option<String>) {
    let result = json!({
        "supportedVersions": SUPPORTED_PROTOCOL_VERSIONS,
        "capabilities": {
            "tools": { "listChanged": false }
        },
        "_meta": {
            "io.modelcontextprotocol/serverInfo": {
                "name": "local-tool-bridge",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    });
    (result, None, Some(DEFAULT_PROTOCOL_VERSION.to_string()))
}

/// `tools/list`: the registry's descriptors, translated to MCP tool shapes.
fn handle_tools_list(dispatcher: &Arc<Dispatcher>) -> Value {
    let tools: Vec<Value> = dispatcher
        .registry()
        .descriptors()
        .iter()
        .map(mcp_tool)
        .collect();
    json!({ "tools": tools })
}

/// Translates one bridge descriptor into an MCP tool definition.
///
/// The name is used verbatim: every advertised tool name already satisfies the
/// MCP pattern `^[a-zA-Z0-9_-]{1,64}$`, so no rewriting is needed.
fn mcp_tool(descriptor: &ToolDescriptor) -> Value {
    json!({
        "name": descriptor.name,
        "description": mcp_description(descriptor),
        "inputSchema": descriptor.input_schema,
    })
}

/// Resolves a client-supplied tool name against the advertised set.
///
/// A name the model invents resolves to `None` and is rejected before anything
/// is dispatched.
fn bridge_name<'a>(descriptors: &'a [ToolDescriptor], candidate: &str) -> Option<&'a str> {
    descriptors
        .iter()
        .find(|descriptor| descriptor.name == candidate)
        .map(|descriptor| descriptor.name.as_str())
}

/// Builds the description ChatGPT/Codex will read. Starts from the bridge
/// descriptor and adds the constraints that matter to a remote model.
fn mcp_description(descriptor: &ToolDescriptor) -> String {
    let mut text = format!("{}\n\n{}", descriptor.summary, descriptor.description);

    if descriptor.default_effect != DefaultEffect::Allow {
        text.push_str("\n\nThis tool may require human approval before it executes.");
    }

    if descriptor.category == "codex-filesystem" {
        text.push_str(
            "\nPaths must be absolute. On Windows, prefer forward slashes (C:/Users/...) \
             over backslashes.",
        );
    }

    text
}

/// `tools/call`: translate an MCP tool call onto the bridge dispatcher, then
/// map the result (or the failure) back into the MCP result shape.
async fn handle_tools_call(
    dispatcher: &Arc<Dispatcher>,
    params: Option<Value>,
    headers: &HeaderMap,
) -> RouteOutcome {
    let params =
        params.ok_or_else(|| (mcp_code::INVALID_PARAMS, "Missing `params`".to_string()))?;

    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| (mcp_code::INVALID_PARAMS, "Missing tool `name`".to_string()))?;

    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    // Resolve the name against the advertised set. Names the model invents are
    // rejected here, before anything is dispatched.
    let descriptors = dispatcher.registry().descriptors();
    let bridge = bridge_name(&descriptors, name)
        .ok_or_else(|| (mcp_code::INVALID_PARAMS, format!("Unknown tool: {name}")))?;

    let user_agent = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown");
    // Char-safe truncation: byte slicing could split a multibyte user agent.
    let origin: String = format!("{MCP_ORIGIN_PREFIX}:{user_agent}")
        .chars()
        .take(128)
        .collect();

    // One dispatcher, one audit trail: the call is exactly what the extension
    // would have sent, with a synthetic id the caller never sees.
    let reply = dispatcher
        .handle(
            BridgeIncoming::Request(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: RequestId::Number(0),
                method: "tools.call".into(),
                params: Some(json!({
                    "name": bridge,
                    "arguments": arguments,
                    "callId": uuid::Uuid::new_v4().to_string(),
                    "origin": origin,
                })),
            }),
            PeerTrust::Untrusted,
        )
        .await;

    let Some(reply) = reply else {
        return Err((
            mcp_code::INTERNAL_ERROR,
            "The bridge produced no response".into(),
        ));
    };

    if let Some(result) = reply.get("result") {
        // A successful bridge call carries the serialised ToolOutput: content
        // blocks plus isError/truncated/duration metadata. MCP wants content
        // and isError; the rest is dropped.
        let content = result.get("content").cloned().unwrap_or_else(|| json!([]));
        let is_error = result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return Ok((
            json!({ "content": content, "isError": is_error }),
            None,
            None,
        ));
    }

    if let Some(error) = reply.get("error") {
        let code = error
            .get("code")
            .and_then(Value::as_i64)
            .unwrap_or(bridge_code::INTERNAL_ERROR);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Tool execution failed")
            .to_string();

        // An unknown tool is a caller mistake; everything else (denied,
        // approval timeout, sandbox refusal, execution failure) is a *tool
        // result* so the model sees it and adapts instead of receiving a
        // protocol error.
        if code == bridge_code::TOOL_NOT_FOUND {
            return Err((mcp_code::INVALID_PARAMS, message));
        }

        return Ok((
            json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
            None,
            None,
        ));
    }

    Err((
        mcp_code::INTERNAL_ERROR,
        "The bridge returned an unrecognised envelope".into(),
    ))
}

/// Binds the loopback MCP listener and serves until the process exits.
pub async fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_name_matches_exactly() {
        let descriptors = vec![ToolDescriptor {
            name: "read_file".into(),
            summary: "s".into(),
            description: "d".into(),
            category: "codex-filesystem".into(),
            input_schema: ltb_core::tools::ObjectSchema {
                schema_type: "object".into(),
                properties: Default::default(),
                required: vec!["path".into()],
            },
            mutating: false,
            default_effect: DefaultEffect::Ask,
            latency_hint: "instant".into(),
        }];

        assert_eq!(bridge_name(&descriptors, "read_file"), Some("read_file"));
        // An internal implementation's name is not advertised, so it must not
        // resolve even though the registry holds it.
        assert_eq!(bridge_name(&descriptors, "fs.read_file"), None);
        assert_eq!(bridge_name(&descriptors, "fs_read_file"), None);
        assert_eq!(bridge_name(&descriptors, "nope"), None);
    }

    #[test]
    fn tool_shape_is_mcp_compliant() {
        let descriptor = ToolDescriptor {
            name: "read_file".into(),
            summary: "Read a file".into(),
            description: "Reads a UTF-8 text file from disk.".into(),
            category: "codex-filesystem".into(),
            input_schema: ltb_core::tools::ObjectSchema {
                schema_type: "object".into(),
                properties: serde_json::from_value(json!({
                    "path": { "type": "string", "description": "Absolute path" }
                }))
                .unwrap(),
                required: vec!["path".into()],
            },
            mutating: false,
            default_effect: DefaultEffect::Ask,
            latency_hint: "instant".into(),
        };

        let tool = mcp_tool(&descriptor);
        assert_eq!(tool["name"], "read_file");
        assert_eq!(tool["inputSchema"]["type"], "object");
        assert_eq!(tool["inputSchema"]["required"], json!(["path"]));
        let description = tool["description"].as_str().unwrap();
        assert!(description.contains("may require human approval"));
        assert!(description.contains("forward slashes"));
    }
}
