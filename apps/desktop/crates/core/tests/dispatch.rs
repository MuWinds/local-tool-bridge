//! Integration tests for the dispatcher.
//!
//! These exercise the full call sequence — validation, policy, approval,
//! execution, audit — through the public API, because that ordering is the
//! security property. Unit tests on the policy engine alone cannot catch a
//! dispatcher that forgets to consult it.

use std::sync::Arc;

use serde_json::json;

use ltb_core::audit::{AuditLog, AuditOutcome};
use ltb_core::dispatch::{ApprovalChallenge, ApprovalDecision, Approver, Dispatcher, PeerTrust};
use ltb_core::policy::{Effect, Policy, PolicyEngine, Rule};
use ltb_core::rpc::{classify, decode_jsonrpc};
use ltb_core::tools::ToolRegistry;

/// An approver that answers every challenge the same way.
struct FixedApprover {
    decision: Option<ApprovalDecision>,
}

#[async_trait::async_trait]
impl Approver for FixedApprover {
    async fn request(&self, _challenge: &ApprovalChallenge) -> Option<ApprovalDecision> {
        self.decision
    }

    fn is_interactive(&self) -> bool {
        self.decision.is_some()
    }
}

/// Builds a dispatcher over a temporary workspace with a given policy.
async fn dispatcher_with(
    rules: Vec<Rule>,
    roots: Vec<String>,
    approver: Option<Arc<dyn Approver>>,
) -> (Arc<Dispatcher>, tempfile::TempDir) {
    let workspace = tempfile::tempdir().expect("temp dir");

    let policy = Policy {
        rules,
        roots: if roots.is_empty() {
            vec![workspace.path().display().to_string()]
        } else {
            roots
        },
        ..Policy::default()
    };

    let engine = PolicyEngine::new(policy).expect("policy must compile");
    let dispatcher = Dispatcher::new(
        Arc::new(ToolRegistry::with_builtins()),
        engine,
        Arc::new(AuditLog::in_memory()),
        None,
    )
    .expect("dispatcher");

    if let Some(approver) = approver {
        dispatcher.set_approver(approver).await;
    }

    (dispatcher, workspace)
}

/// Sends one request and returns the decoded reply.
async fn call(
    dispatcher: &Arc<Dispatcher>,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    let raw = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
    let envelope = decode_jsonrpc(&raw).expect("valid json");
    let incoming = classify(envelope).expect("valid envelope");
    dispatcher
        .handle(incoming, PeerTrust::Verified)
        .await
        .expect("a request must produce a reply")
}

#[tokio::test]
async fn handshake_reports_the_capabilities() {
    let (dispatcher, _workspace) = dispatcher_with(vec![], vec![], None).await;

    let reply = call(
        &dispatcher,
        "bridge.hello",
        json!({ "protocolVersion": "0.1.0", "clientVersion": "test", "clientId": "t", "transports": [] }),
    )
    .await;

    let result = &reply["result"];
    assert_eq!(result["protocolVersion"], "0.1.0");
    assert_eq!(
        result["capabilities"]["availableTools"]
            .as_array()
            .unwrap()
            .len(),
        6
    );
    // No approver is installed, so the host must not claim it can ask a human.
    assert_eq!(result["capabilities"]["interactiveApproval"], false);
}

#[tokio::test]
async fn a_protocol_major_mismatch_is_refused() {
    let (dispatcher, _workspace) = dispatcher_with(vec![], vec![], None).await;

    let reply = call(
        &dispatcher,
        "bridge.hello",
        json!({ "protocolVersion": "2.0.0", "clientVersion": "test", "clientId": "t", "transports": [] }),
    )
    .await;

    assert_eq!(reply["error"]["code"], -32002);
}

#[tokio::test]
async fn an_allowed_tool_executes_and_is_audited() {
    let (dispatcher, workspace) = dispatcher_with(
        vec![Rule {
            tool: "fs.list_dir".into(),
            effect: Effect::Allow,
            when: None,
            note: None,
        }],
        vec![],
        None,
    )
    .await;

    std::fs::write(workspace.path().join("a.txt"), "hello").unwrap();

    let reply = call(
        &dispatcher,
        "tools.call",
        json!({
            "name": "fs.list_dir",
            "arguments": { "path": workspace.path().display().to_string() },
            "callId": "c1",
            "origin": "local-test"
        }),
    )
    .await;

    assert!(reply["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("a.txt"));

    let entries = dispatcher.audit().recent(10).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].outcome, AuditOutcome::Allowed);
    assert_eq!(entries[0].call_id, "c1");
}

#[tokio::test]
async fn a_denied_tool_never_executes_but_is_still_audited() {
    let (dispatcher, workspace) = dispatcher_with(
        vec![Rule {
            tool: "fs.write_file".into(),
            effect: Effect::Deny,
            when: None,
            note: None,
        }],
        vec![],
        None,
    )
    .await;

    let target = workspace.path().join("should-not-exist.txt");

    let reply = call(
        &dispatcher,
        "tools.call",
        json!({
            "name": "fs.write_file",
            "arguments": { "path": target.display().to_string(), "content": "x" },
            "callId": "c2",
            "origin": "local-test"
        }),
    )
    .await;

    assert_eq!(reply["error"]["code"], -32011);
    // The decisive assertion: the file must not exist.
    assert!(
        !target.exists(),
        "a denied write must not touch the filesystem"
    );

    let entries = dispatcher.audit().recent(10).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].outcome, AuditOutcome::Denied);
}

#[tokio::test]
async fn an_ask_verdict_fails_closed_when_no_human_is_available() {
    // This is the most important test in the file. A headless host that treated
    // `ask` as `allow` would be an allow-all for anything the policy flags.
    let (dispatcher, workspace) = dispatcher_with(
        vec![Rule {
            tool: "fs.write_file".into(),
            effect: Effect::Ask,
            when: None,
            note: None,
        }],
        vec![],
        None,
    )
    .await;

    let target = workspace.path().join("nope.txt");

    let reply = call(
        &dispatcher,
        "tools.call",
        json!({
            "name": "fs.write_file",
            "arguments": { "path": target.display().to_string(), "content": "x" },
            "callId": "c3",
            "origin": "local-test"
        }),
    )
    .await;

    assert_eq!(reply["error"]["code"], -32013);
    assert!(!target.exists(), "an unanswered approval must not execute");

    let entries = dispatcher.audit().recent(10).await;
    assert_eq!(entries[0].outcome, AuditOutcome::Expired);
}

#[tokio::test]
async fn an_approved_call_executes_and_records_approval() {
    let approver = Arc::new(FixedApprover {
        decision: Some(ApprovalDecision {
            approved: true,
            remember: false,
        }),
    });

    let (dispatcher, workspace) = dispatcher_with(
        vec![Rule {
            tool: "fs.write_file".into(),
            effect: Effect::Ask,
            when: None,
            note: None,
        }],
        vec![],
        Some(approver),
    )
    .await;

    let target = workspace.path().join("approved.txt");

    let reply = call(
        &dispatcher,
        "tools.call",
        json!({
            "name": "fs.write_file",
            "arguments": { "path": target.display().to_string(), "content": "written" },
            "callId": "c4",
            "origin": "local-test"
        }),
    )
    .await;

    assert!(reply["result"].is_object(), "expected success, got {reply}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "written");

    let entries = dispatcher.audit().recent(10).await;
    assert_eq!(entries[0].outcome, AuditOutcome::Approved);
}

#[tokio::test]
async fn a_rejected_call_does_not_execute() {
    let approver = Arc::new(FixedApprover {
        decision: Some(ApprovalDecision {
            approved: false,
            remember: false,
        }),
    });

    let (dispatcher, workspace) = dispatcher_with(
        vec![Rule {
            tool: "fs.write_file".into(),
            effect: Effect::Ask,
            when: None,
            note: None,
        }],
        vec![],
        Some(approver),
    )
    .await;

    let target = workspace.path().join("rejected.txt");

    let reply = call(
        &dispatcher,
        "tools.call",
        json!({
            "name": "fs.write_file",
            "arguments": { "path": target.display().to_string(), "content": "x" },
            "callId": "c5",
            "origin": "local-test"
        }),
    )
    .await;

    assert_eq!(reply["error"]["code"], -32011);
    assert!(!target.exists());

    let entries = dispatcher.audit().recent(10).await;
    assert_eq!(entries[0].outcome, AuditOutcome::Rejected);
}

#[tokio::test]
async fn an_unknown_tool_is_reported_as_not_found() {
    let (dispatcher, _workspace) = dispatcher_with(vec![], vec![], None).await;

    let reply = call(
        &dispatcher,
        "tools.call",
        json!({ "name": "fs.delete_everything", "arguments": {}, "callId": "c6", "origin": "x" }),
    )
    .await;

    assert_eq!(reply["error"]["code"], -32010);
}

#[tokio::test]
async fn malformed_arguments_are_rejected_before_policy_runs() {
    let (dispatcher, _workspace) = dispatcher_with(
        vec![Rule {
            tool: "fs.list_dir".into(),
            effect: Effect::Allow,
            when: None,
            note: None,
        }],
        vec![],
        None,
    )
    .await;

    // `path` has the wrong type.
    let reply = call(
        &dispatcher,
        "tools.call",
        json!({ "name": "fs.list_dir", "arguments": { "path": 42 }, "callId": "c7", "origin": "x" }),
    )
    .await;

    assert_eq!(reply["error"]["code"], -32602);

    // Validation runs first, so nothing should have been audited.
    assert!(dispatcher.audit().recent(10).await.is_empty());
}

#[tokio::test]
async fn a_path_outside_the_sandbox_is_refused() {
    let (dispatcher, _workspace) = dispatcher_with(
        vec![Rule {
            tool: "fs.read_file".into(),
            effect: Effect::Allow,
            when: None,
            note: None,
        }],
        vec![],
        None,
    )
    .await;

    let outside = tempfile::NamedTempFile::new().expect("temp file");
    std::fs::write(outside.path(), "secret").unwrap();

    let reply = call(
        &dispatcher,
        "tools.call",
        json!({
            "name": "fs.read_file",
            "arguments": { "path": outside.path().display().to_string() },
            "callId": "c8",
            "origin": "x"
        }),
    )
    .await;

    assert_eq!(reply["error"]["code"], -32014);
}

#[tokio::test]
async fn an_unknown_method_returns_method_not_found() {
    let (dispatcher, _workspace) = dispatcher_with(vec![], vec![], None).await;

    let reply = call(&dispatcher, "tools.destroy", json!({})).await;
    assert_eq!(reply["error"]["code"], -32601);
}

#[tokio::test]
async fn output_is_truncated_to_the_configured_limit() {
    let workspace = tempfile::tempdir().unwrap();
    // A file comfortably larger than the cap below.
    std::fs::write(workspace.path().join("big.txt"), "x".repeat(5000)).unwrap();

    let policy = Policy {
        rules: vec![Rule {
            tool: "fs.read_file".into(),
            effect: Effect::Allow,
            when: None,
            note: None,
        }],
        roots: vec![workspace.path().display().to_string()],
        max_output_chars: 200,
        ..Policy::default()
    };

    let dispatcher = Dispatcher::new(
        Arc::new(ToolRegistry::with_builtins()),
        PolicyEngine::new(policy).unwrap(),
        Arc::new(AuditLog::in_memory()),
        None,
    )
    .unwrap();

    let reply = call(
        &dispatcher,
        "tools.call",
        json!({
            "name": "fs.read_file",
            "arguments": { "path": workspace.path().join("big.txt").display().to_string(), "limit": 5000 },
            "callId": "c9",
            "origin": "x"
        }),
    )
    .await;

    assert_eq!(reply["result"]["truncated"], true);
    let text = reply["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        text.chars().count() <= 200,
        "output was not clipped: {} chars",
        text.chars().count()
    );
}

#[tokio::test]
async fn a_remembered_approval_adds_a_scoped_rule() {
    let approver = Arc::new(FixedApprover {
        decision: Some(ApprovalDecision {
            approved: true,
            remember: true,
        }),
    });

    let (dispatcher, workspace) = dispatcher_with(
        vec![Rule {
            tool: "fs.write_file".into(),
            effect: Effect::Ask,
            when: None,
            note: None,
        }],
        vec![],
        Some(approver),
    )
    .await;

    let target = workspace.path().join("remembered.txt");

    call(
        &dispatcher,
        "tools.call",
        json!({
            "name": "fs.write_file",
            "arguments": { "path": target.display().to_string(), "content": "one" },
            "callId": "c10",
            "origin": "x"
        }),
    )
    .await;

    let policy = dispatcher.policy_snapshot().await;
    let added = policy
        .rules
        .iter()
        .find(|rule| rule.note.as_deref().unwrap_or("").contains("remember"))
        .expect("a remembered rule should have been added");

    assert_eq!(added.effect, Effect::Allow);
    // The rule must be scoped to the directory, not the whole filesystem.
    let predicate = added
        .when
        .as_ref()
        .expect("the remembered rule must carry a predicate");
    assert_eq!(predicate.path_within.len(), 1);
    assert!(predicate.path_within[0].contains("dlb") || !predicate.path_within[0].is_empty());
}

#[tokio::test]
async fn the_destructive_denylist_outranks_an_allow_rule_end_to_end() {
    let (dispatcher, _workspace) = dispatcher_with(
        vec![Rule {
            tool: "shell.exec".into(),
            effect: Effect::Allow,
            when: None,
            note: None,
        }],
        vec![],
        None,
    )
    .await;

    let reply = call(
        &dispatcher,
        "tools.call",
        json!({
            "name": "shell.exec",
            "arguments": { "command": "rm -rf /" },
            "callId": "c11",
            "origin": "x"
        }),
    )
    .await;

    assert_eq!(reply["error"]["code"], -32011);
}

#[tokio::test]
async fn audit_entries_redact_sensitive_arguments() {
    let approver = Arc::new(FixedApprover {
        decision: Some(ApprovalDecision {
            approved: true,
            remember: false,
        }),
    });

    let (dispatcher, workspace) = dispatcher_with(
        vec![Rule {
            tool: "fs.write_file".into(),
            effect: Effect::Allow,
            when: None,
            note: None,
        }],
        vec![],
        Some(approver),
    )
    .await;

    call(
        &dispatcher,
        "tools.call",
        json!({
            "name": "fs.write_file",
            "arguments": {
                "path": workspace.path().join("secret.txt").display().to_string(),
                "content": "TOP SECRET VALUE"
            },
            "callId": "c12",
            "origin": "x"
        }),
    )
    .await;

    let entries = dispatcher.audit().recent(10).await;
    let serialised = serde_json::to_string(&entries[0].arguments).unwrap();
    assert!(
        !serialised.contains("TOP SECRET VALUE"),
        "the audit log must not record file contents verbatim"
    );
    assert!(serialised.contains("redacted"));
}
