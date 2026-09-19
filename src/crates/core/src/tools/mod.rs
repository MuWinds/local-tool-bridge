//! Tool registry and the `Tool` trait.

use crate::error::{BridgeError, Result};
use crate::policy::PolicyEngine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

pub mod codex;
pub mod fs;
pub mod shell;

/// Category prefix that marks a descriptor as part of the client-facing set.
const EXPOSED_CATEGORY_PREFIX: &str = "codex-";

/// Whether a descriptor belongs to the set advertised to clients.
fn is_exposed_descriptor(descriptor: &ToolDescriptor) -> bool {
    descriptor.category.starts_with(EXPOSED_CATEGORY_PREFIX)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DefaultEffect {
    Allow,
    Ask,
    Deny,
}
impl From<DefaultEffect> for crate::policy::Effect {
    fn from(v: DefaultEffect) -> Self {
        match v {
            DefaultEffect::Allow => crate::policy::Effect::Allow,
            DefaultEffect::Ask => crate::policy::Effect::Ask,
            DefaultEffect::Deny => crate::policy::Effect::Deny,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectSchema {
    #[serde(rename = "type")]
    pub schema_type: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub properties: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub summary: String,
    pub description: String,
    pub category: String,
    pub input_schema: ObjectSchema,
    pub mutating: bool,
    pub default_effect: DefaultEffect,
    pub latency_hint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    pub text: String,
}
impl ContentBlock {
    pub fn text(t: impl Into<String>) -> Self {
        Self {
            block_type: "text".into(),
            text: t.into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutput {
    pub content: Vec<ContentBlock>,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_bytes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}
impl ToolOutput {
    pub fn ok(t: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::text(t)],
            is_error: false,
            truncated: false,
            original_bytes: None,
            duration_ms: None,
        }
    }
    pub fn error(t: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::text(t)],
            is_error: true,
            truncated: false,
            original_bytes: None,
            duration_ms: None,
        }
    }
    pub fn truncate_to(mut self, max: usize) -> Self {
        let total: usize = self.content.iter().map(|b| b.text.len()).sum();
        if total <= max {
            return self;
        }
        let mut left = max;
        let mut out = Vec::new();
        for b in self.content {
            if left == 0 {
                break;
            }
            if b.text.len() <= left {
                left -= b.text.len();
                out.push(b);
            } else {
                let mut e = left;
                while e > 0 && !b.text.is_char_boundary(e) {
                    e -= 1;
                }
                out.push(ContentBlock::text(&b.text[..e]));
                break;
            }
        }
        self.content = out;
        self.truncated = true;
        self.original_bytes = Some(total);
        self
    }
}
pub struct ToolContext<'a> {
    pub policy: &'a PolicyEngine,
    pub call_id: &'a str,
    pub origin: &'a str,
}
#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn descriptor(&self) -> ToolDescriptor;
    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput>;
}
pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn Tool>>,
}
impl ToolRegistry {
    /// The registry every transport starts from: exactly the tools advertised to
    /// clients, and nothing else.
    ///
    /// The `fs`/`shell` implementations still exist, but they are internal: the
    /// Codex wrappers call them directly, so registering them here would only
    /// add names that `tools.list` never shows and `tools.call` must reject.
    pub fn with_builtins() -> Self {
        let mut r = Self {
            tools: BTreeMap::new(),
        };
        r.register(Arc::new(codex::ReadFile));
        r.register(Arc::new(codex::ListDir));
        r.register(Arc::new(codex::Exec));
        r.register(Arc::new(codex::UnifiedExec));
        r.register(Arc::new(codex::ApplyPatch));
        r
    }
    pub fn register(&mut self, t: Arc<dyn Tool>) {
        self.tools.insert(t.descriptor().name, t);
    }
    pub fn get(&self, n: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.get(n)
    }
    pub fn require(&self, n: &str) -> Result<&Arc<dyn Tool>> {
        self.get(n).ok_or_else(|| BridgeError::tool_not_found(n))
    }
    /// Whether a tool is part of the client-facing set.
    ///
    /// `get` and `require` see every registered tool, including ones that are
    /// deliberately withheld from clients. A caller that turns an untrusted name
    /// into an execution must gate on this first, or `tools.call` becomes a way
    /// to reach a tool that `tools.list` never advertises.
    pub fn is_exposed(&self, name: &str) -> bool {
        self.tools
            .get(name)
            .is_some_and(|tool| is_exposed_descriptor(&tool.descriptor()))
    }

    /// Descriptors for the tools exposed to clients: the Codex-compatible set.
    pub fn descriptors(&self) -> Vec<ToolDescriptor> {
        self.tools
            .values()
            .filter(|t| is_exposed_descriptor(&t.descriptor()))
            .map(|t| t.descriptor())
            .collect()
    }
    pub fn names(&self) -> Vec<String> {
        self.descriptors().into_iter().map(|d| d.name).collect()
    }
}
impl Default for ToolRegistry {
    fn default() -> Self {
        Self::with_builtins()
    }
}
pub fn required_str(a: &Value, k: &str) -> Result<String> {
    a.get(k)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            BridgeError::invalid_params(format!("Missing required string argument `{k}`"))
        })
}
pub fn optional_str(a: &Value, k: &str) -> Option<String> {
    a.get(k).and_then(Value::as_str).map(str::to_string)
}
pub fn optional_u64(a: &Value, k: &str, d: u64) -> u64 {
    a.get(k).and_then(Value::as_u64).unwrap_or(d)
}
pub fn optional_bool(a: &Value, k: &str, d: bool) -> bool {
    a.get(k).and_then(Value::as_bool).unwrap_or(d)
}
pub fn clamp_u64(v: u64, min: u64, max: u64) -> u64 {
    v.clamp(min, max)
}
