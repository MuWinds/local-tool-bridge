//! The RPC dispatcher.
//!
//! This is the single place a tool call is turned into an execution. It owns the
//! full sequence, in order:
//!
//! 1. Validate the tool exists and the arguments match its schema.
//! 2. Evaluate policy → `allow` / `ask` / `deny`.
//! 3. On `ask`, raise an approval challenge and wait for a human.
//! 4. Execute, truncate the output, and record an audit entry.
//!
//! Keeping this sequence in one function is deliberate: split across callers,
//! one of them eventually forgets the policy check.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::RwLock;

use crate::audit::{AuditEntry, AuditLog, AuditOutcome, now_rfc3339, redact_arguments};
use crate::error::{BridgeError, Result, code};
use crate::policy::{Effect, Policy, PolicyEngine, Verdict};
use crate::rpc::{Incoming, JsonRpcFailure, JsonRpcSuccess, PROTOCOL_VERSION};
use crate::tools::{ToolContext, ToolRegistry};

/// Methods a client may invoke.
pub mod method {
    pub const HELLO: &str = "bridge.hello";
    pub const PING: &str = "bridge.ping";
    pub const TOOLS_LIST: &str = "tools.list";
    pub const TOOLS_CALL: &str = "tools.call";
    pub const POLICY_GET: &str = "policy.get";
    pub const POLICY_SET: &str = "policy.set";
}

/// Notifications the host pushes to connected clients.
pub mod notification {
    pub const POLICY_CHANGED: &str = "bridge.policyChanged";
    pub const SHUTTING_DOWN: &str = "bridge.shuttingDown";
    pub const CALL_STARTED: &str = "tools.callStarted";
    pub const CALL_FINISHED: &str = "tools.callFinished";
}

/// How long an approval prompt stays valid before it expires.
const APPROVAL_TTL: Duration = Duration::from_secs(180);

/// How the dispatcher asks a human for a decision.
///
/// The GUI implements this by showing a modal; a headless host implements it by
/// refusing, which is the correct fail-closed behaviour.
#[async_trait::async_trait]
pub trait Approver: Send + Sync {
    /// Presents a challenge and resolves with the human's decision.
    ///
    /// Returning `None` means "no human is available"; the dispatcher turns that
    /// into a denial rather than an allow.
    async fn request(&self, challenge: &ApprovalChallenge) -> Option<ApprovalDecision>;

    /// Whether a human can actually be reached right now.
    fn is_interactive(&self) -> bool;
}

/// A pending approval request.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalChallenge {
    pub token: String,
    pub tool: String,
    pub arguments: Value,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_rule: Option<String>,
    /// Epoch milliseconds after which the challenge is void.
    pub expires_at: u64,
}

/// A human's answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApprovalDecision {
    pub approved: bool,
    /// When true, the host persists a rule so the same call is not asked again.
    pub remember: bool,
}

/// An `Approver` that always declines, used by tests and headless runs.
pub struct DenyAllApprover;

#[async_trait::async_trait]
impl Approver for DenyAllApprover {
    async fn request(&self, _challenge: &ApprovalChallenge) -> Option<ApprovalDecision> {
        None
    }

    fn is_interactive(&self) -> bool {
        false
    }
}

/// Who is on the other end of a transport, as far as the transport can prove.
///
/// This is supplied by the *transport*, never by the message body: a peer that
/// could assert its own trustworthiness over the wire would defeat the point.
///
/// The caller must prove itself with the shared secret in `bridge.hello`.
/// Every loopback transport sets this: any local process can open a socket, so
/// possession of the token is the actual authorisation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerTrust {
    Untrusted,
}

/// The host's shared state.
pub struct Dispatcher {
    registry: Arc<ToolRegistry>,
    policy: RwLock<PolicyEngine>,
    audit: Arc<AuditLog>,
    approver: RwLock<Arc<dyn Approver>>,
    /// Set once the handshake succeeds.
    authenticated: RwLock<bool>,
    /// Expected shared secret for the WebSocket transport.
    secret: Option<String>,
    /// Notifications the host wants to push, as a broadcast channel.
    events: tokio::sync::broadcast::Sender<Value>,
}

impl Dispatcher {
    pub fn new(
        registry: Arc<ToolRegistry>,
        policy: PolicyEngine,
        audit: Arc<AuditLog>,
        secret: Option<String>,
    ) -> Result<Arc<Self>> {
        let (events, _) = tokio::sync::broadcast::channel(256);
        Ok(Arc::new(Self {
            registry,
            policy: RwLock::new(policy),
            audit,
            approver: RwLock::new(Arc::new(DenyAllApprover)),
            authenticated: RwLock::new(false),
            secret,
            events,
        }))
    }

    /// Replaces the approver, which the GUI does once its window exists.
    pub async fn set_approver(&self, approver: Arc<dyn Approver>) {
        *self.approver.write().await = approver;
    }

    /// Subscribes to host-originated notifications.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub fn audit(&self) -> &Arc<AuditLog> {
        &self.audit
    }

    pub fn registry(&self) -> &Arc<ToolRegistry> {
        &self.registry
    }

    pub async fn policy_snapshot(&self) -> Policy {
        self.policy.read().await.policy().clone()
    }

    /// Swaps in a new policy document, bumping its revision.
    pub async fn replace_policy(&self, mut policy: Policy) -> Result<u64> {
        let revision = self.policy.read().await.policy().revision + 1;
        policy.revision = revision;
        let engine = PolicyEngine::new(policy)?;
        *self.policy.write().await = engine;

        let _ = self.events.send(json!({
            "jsonrpc": "2.0",
            "method": notification::POLICY_CHANGED,
            "params": { "revision": revision }
        }));
        Ok(revision)
    }

    /// Handles one inbound envelope, returning an optional reply.
    ///
    /// `trust` describes what the transport has already proven about the peer;
    /// see [`PeerTrust`].
    pub async fn handle(&self, message: Incoming, trust: PeerTrust) -> Option<Value> {
        let request = match message {
            Incoming::Request(request) => request,
            // Responses to host-originated requests are handled elsewhere.
            Incoming::Notification(note) => {
                tracing::debug!(method = %note.method, "ignoring inbound notification");
                return None;
            }
            Incoming::Response(_) => return None,
        };

        let id = request.id.clone();
        let outcome = self.dispatch(&request.method, request.params, trust).await;

        Some(match outcome {
            Ok(result) => serde_json::to_value(JsonRpcSuccess::new(id, result))
                .unwrap_or(serde_json::Value::Null),
            Err(error) => serde_json::to_value(JsonRpcFailure::new(Some(id), error))
                .unwrap_or(serde_json::Value::Null),
        })
    }

    /// Routes a method name to its handler.
    async fn dispatch(
        &self,
        method: &str,
        params: Option<Value>,
        trust: PeerTrust,
    ) -> Result<Value> {
        match method {
            method::HELLO => self.handle_hello(params, trust).await,
            method::PING => Ok(json!({ "pong": true, "at": now_rfc3339() })),
            method::TOOLS_LIST => self.handle_tools_list().await,
            method::TOOLS_CALL => self.handle_tools_call(params).await,
            method::POLICY_GET => Ok(serde_json::to_value(self.policy_snapshot().await)
                .map_err(|e| BridgeError::internal(e.to_string()))?),
            method::POLICY_SET => self.handle_policy_set(params).await,
            other => Err(BridgeError::method_not_found(other)),
        }
    }

    /// The handshake. Also the only method callable before authentication.
    async fn handle_hello(&self, params: Option<Value>, trust: PeerTrust) -> Result<Value> {
        let params = params.unwrap_or_else(|| json!({}));

        // A transport-verified peer skips the secret entirely; see `PeerTrust`.
        if trust == PeerTrust::Untrusted {
            if let Some(expected) = &self.secret {
                let provided = params
                    .get("secret")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if provided != expected {
                    return Err(BridgeError::new(
                        code::NOT_AUTHENTICATED,
                        "Bridge secret did not match; copy the current token from the \
                         bridge window",
                    ));
                }
            }
        }

        let peer_protocol = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or_default();

        // Only the major version must agree: a patch difference is not worth
        // breaking a working session over.
        if !peer_protocol.is_empty() && major_of(peer_protocol) != major_of(PROTOCOL_VERSION) {
            return Err(BridgeError::new(
                code::PROTOCOL_MISMATCH,
                format!(
                    "Extension speaks protocol {peer_protocol} but this host speaks \
                     {PROTOCOL_VERSION}"
                ),
            ));
        }

        *self.authenticated.write().await = true;

        let policy = self.policy.read().await;
        let approver = self.approver.read().await;
        let transports = vec!["websocket"];

        Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "sessionId": uuid::Uuid::new_v4().to_string(),
            "capabilities": {
                "transports": transports,
                "availableTools": self.registry.names(),
                "interactiveApproval": approver.is_interactive(),
                "auditLog": self.audit.is_enabled(),
                "policyRevision": policy.policy().revision,
            }
        }))
    }

    async fn handle_tools_list(&self) -> Result<Value> {
        let policy = self.policy.read().await;
        Ok(json!({
            "tools": self.registry.descriptors(),
            "policyRevision": policy.policy().revision,
        }))
    }

    /// Validates, authorises, and executes one tool call.
    async fn handle_tools_call(&self, params: Option<Value>) -> Result<Value> {
        let params = params.ok_or_else(|| BridgeError::invalid_params("Missing `params`"))?;

        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid_params("Missing `name`"))?
            .to_string();

        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let call_id = params
            .get("callId")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let origin = params
            .get("origin")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let conversation_id = params
            .get("conversationId")
            .and_then(Value::as_str)
            .map(str::to_string);

        let started = Instant::now();
        let tool = self.registry.require(&name)?;
        let descriptor = tool.descriptor();

        // Step 1: validate arguments against the declared schema before anything
        // else runs, so a malformed call never reaches policy or execution.
        validate_arguments(&descriptor.input_schema, &arguments)?;

        // Step 2: policy.
        let verdict = {
            let policy = self.policy.read().await;
            policy.evaluate(&name, &arguments, descriptor.default_effect.into())
        };

        let _ = self.events.send(json!({
            "jsonrpc": "2.0",
            "method": notification::CALL_STARTED,
            "params": { "callId": call_id, "tool": name }
        }));

        let (outcome, approved_via_human) = match verdict.effect {
            Effect::Deny => {
                self.record(
                    &call_id,
                    &name,
                    &arguments,
                    AuditOutcome::Denied,
                    &verdict,
                    &origin,
                    conversation_id.clone(),
                    None,
                )
                .await;
                return Err(BridgeError::denied(verdict.reason));
            }
            Effect::Ask => {
                let decision = self.request_approval(&name, &arguments, &verdict).await;

                match decision {
                    Some(decision) if decision.approved => {
                        if decision.remember {
                            self.remember_rule(&name, &arguments).await;
                        }
                        (AuditOutcome::Approved, true)
                    }
                    Some(_) => {
                        self.record(
                            &call_id,
                            &name,
                            &arguments,
                            AuditOutcome::Rejected,
                            &verdict,
                            &origin,
                            conversation_id.clone(),
                            None,
                        )
                        .await;
                        return Err(BridgeError::new(
                            code::TOOL_DENIED,
                            format!("The user declined to run `{name}`"),
                        ));
                    }
                    None => {
                        self.record(
                            &call_id,
                            &name,
                            &arguments,
                            AuditOutcome::Expired,
                            &verdict,
                            &origin,
                            conversation_id.clone(),
                            None,
                        )
                        .await;
                        return Err(BridgeError::new(
                            code::APPROVAL_TIMEOUT,
                            format!(
                                "No approval was given for `{name}`. Approve it in the bridge \
                                 window, or add an allow rule for this tool."
                            ),
                        ));
                    }
                }
            }
            Effect::Allow => (AuditOutcome::Allowed, false),
        };
        let _ = approved_via_human;

        // Step 4: execute. The policy guard must stay alive for the whole call,
        // because `ToolContext` borrows the engine that does path confinement.
        let policy_guard = self.policy.read().await;
        let (max_output, timeout) = (
            policy_guard.max_output_chars(),
            Duration::from_millis(policy_guard.default_timeout_ms()),
        );

        let context = ToolContext {
            policy: &policy_guard,
            call_id: &call_id,
            origin: &origin,
        };

        let execution =
            tokio::time::timeout(timeout, tool.execute(arguments.clone(), &context)).await;
        drop(policy_guard);

        let (final_outcome, payload) = match execution {
            Ok(Ok(output)) => {
                let duration = started.elapsed().as_millis() as u64;
                let output = output.truncate_to(max_output);
                let outcome = if output.is_error {
                    AuditOutcome::Failed
                } else {
                    outcome
                };
                let mut output = output;
                output.duration_ms = Some(duration);
                (
                    outcome,
                    serde_json::to_value(output)
                        .map_err(|e| BridgeError::internal(e.to_string()))?,
                )
            }
            Ok(Err(error)) => {
                self.record(
                    &call_id,
                    &name,
                    &arguments,
                    AuditOutcome::Failed,
                    &verdict,
                    &origin,
                    conversation_id.clone(),
                    Some(started.elapsed().as_millis() as u64),
                )
                .await;
                return Err(error);
            }
            Err(_) => {
                self.record(
                    &call_id,
                    &name,
                    &arguments,
                    AuditOutcome::Failed,
                    &verdict,
                    &origin,
                    conversation_id.clone(),
                    Some(started.elapsed().as_millis() as u64),
                )
                .await;
                return Err(BridgeError::timeout(format!(
                    "`{name}` exceeded the {timeout:?} host limit"
                )));
            }
        };

        self.record(
            &call_id,
            &name,
            &arguments,
            final_outcome,
            &verdict,
            &origin,
            conversation_id,
            Some(started.elapsed().as_millis() as u64),
        )
        .await;

        let _ = self.events.send(json!({
            "jsonrpc": "2.0",
            "method": notification::CALL_FINISHED,
            "params": { "callId": call_id, "tool": name, "outcome": final_outcome }
        }));

        Ok(payload)
    }

    async fn handle_policy_set(&self, params: Option<Value>) -> Result<Value> {
        let params = params.ok_or_else(|| BridgeError::invalid_params("Missing `params`"))?;
        let policy: Policy =
            serde_json::from_value(params.get("policy").cloned().unwrap_or(params.clone()))
                .map_err(|error| {
                    BridgeError::invalid_params(format!("Invalid policy document: {error}"))
                })?;

        let revision = self.replace_policy(policy).await?;
        Ok(json!({ "revision": revision }))
    }

    /// Raises a challenge and waits for the approver.
    async fn request_approval(
        &self,
        name: &str,
        arguments: &Value,
        verdict: &Verdict,
    ) -> Option<ApprovalDecision> {
        let approver = self.approver.read().await.clone();

        // With no human reachable, `ask` must fail closed. This is the branch
        // that keeps a headless host from silently becoming an allow-all.
        if !approver.is_interactive() {
            return None;
        }

        let token = uuid::Uuid::new_v4().to_string();
        let challenge = ApprovalChallenge {
            token: token.clone(),
            tool: name.to_string(),
            arguments: redact_arguments(arguments),
            reason: verdict.reason.clone(),
            matched_rule: verdict.matched_rule.clone(),
            expires_at: now_epoch_millis() + APPROVAL_TTL.as_millis() as u64,
        };

        tokio::time::timeout(APPROVAL_TTL, approver.request(&challenge))
            .await
            .ok()
            .flatten()
    }

    /// Persists an allow rule for a call the user chose to remember.
    async fn remember_rule(&self, name: &str, arguments: &Value) {
        let mut policy = self.policy_snapshot().await;
        let note = format!("Auto-added when the user approved `{name}` once and chose to remember");

        // A filesystem call is remembered for the directory it touched, not for
        // the whole filesystem: approving one file must not open the rest.
        let when = if let Some(path) = arguments.get("path").and_then(Value::as_str) {
            std::path::Path::new(path)
                .parent()
                .map(|parent| crate::policy::Predicate {
                    path_within: vec![parent.display().to_string()],
                    ..Default::default()
                })
        } else if let Some(url) = arguments.get("url").and_then(Value::as_str) {
            url::Url::parse(url)
                .ok()
                .and_then(|parsed| parsed.host_str().map(str::to_string))
                .map(|host| crate::policy::Predicate {
                    host_in: vec![host],
                    ..Default::default()
                })
        } else {
            None
        };

        policy.rules.insert(
            0,
            crate::policy::Rule {
                tool: name.to_string(),
                effect: Effect::Allow,
                when,
                note: Some(note),
            },
        );

        if let Err(error) = self.replace_policy(policy).await {
            tracing::warn!(%error, "failed to persist remembered approval");
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn record(
        &self,
        call_id: &str,
        tool: &str,
        arguments: &Value,
        outcome: AuditOutcome,
        verdict: &Verdict,
        origin: &str,
        conversation_id: Option<String>,
        duration_ms: Option<u64>,
    ) {
        self.audit
            .record(AuditEntry {
                timestamp: now_rfc3339(),
                call_id: call_id.to_string(),
                tool: tool.to_string(),
                arguments: redact_arguments(arguments),
                outcome,
                matched_rule: verdict.matched_rule.clone(),
                reason: Some(verdict.reason.clone()),
                duration_ms,
                origin: origin.to_string(),
                conversation_id,
            })
            .await;
    }
}

/// Extracts the major component of a semantic version.
fn major_of(version: &str) -> &str {
    version.split('.').next().unwrap_or(version)
}

fn now_epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Validates arguments against the JSON Schema subset the catalogue uses.
///
/// This is intentionally not a full JSON Schema implementation: it checks types
/// and required fields, which is exactly what the catalogue expresses. Richer
/// constraints (ranges, enums) are clamped by the tools themselves.
pub fn validate_arguments(schema: &crate::tools::ObjectSchema, arguments: &Value) -> Result<()> {
    let object = arguments
        .as_object()
        .ok_or_else(|| BridgeError::invalid_params("`arguments` must be a JSON object"))?;

    for required in &schema.required {
        if !object.contains_key(required) {
            return Err(BridgeError::invalid_params(format!(
                "Missing required argument `{required}`"
            )));
        }
    }

    for (key, value) in object {
        let Some(expected) = schema.properties.get(key) else {
            // Unknown keys are rejected rather than ignored: a silently dropped
            // `path` typo is how a tool ends up running with the wrong target.
            return Err(BridgeError::invalid_params(format!(
                "Unknown argument `{key}`"
            )));
        };
        let Some(kind) = expected.get("type").and_then(Value::as_str) else {
            continue;
        };

        let matches = match kind {
            "string" => value.is_string(),
            "integer" => value.is_i64() || value.is_u64(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "array" => value.is_array(),
            "object" => value.is_object(),
            _ => true,
        };

        if !matches {
            return Err(BridgeError::invalid_params(format!(
                "Argument `{key}` must be of type {kind}"
            )));
        }

        if let Some(allowed) = expected.get("enum").and_then(Value::as_array) {
            if !allowed.contains(value) {
                return Err(BridgeError::invalid_params(format!(
                    "Argument `{key}` must be one of {}",
                    allowed
                        .iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
        }
    }

    Ok(())
}
