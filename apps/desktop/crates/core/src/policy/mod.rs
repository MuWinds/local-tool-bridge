//! Policy evaluation and filesystem/network confinement.

use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{BridgeError, Result};

pub mod path;
pub use path::{lexical_normalize, PathSandbox};
pub type Sandbox = PathSandbox;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    Allow,
    Ask,
    Deny,
}

impl Effect {
    pub fn or_default(self, _default: Effect) -> Effect {
        self
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Predicate {
    pub path_within: Vec<String>,
    pub host_in: Vec<String>,
    pub command_not_matches: Vec<String>,
}

impl Predicate {
    pub fn is_empty(&self) -> bool {
        self.path_within.is_empty()
            && self.host_in.is_empty()
            && self.command_not_matches.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub tool: String,
    pub effect: Effect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<Predicate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Verdict {
    pub effect: Effect,
    pub reason: String,
    pub matched_rule: Option<String>,
}

impl Verdict {
    pub fn allow(reason: impl Into<String>) -> Self {
        Self {
            effect: Effect::Allow,
            reason: reason.into(),
            matched_rule: None,
        }
    }

    pub fn deny(reason: impl Into<String>) -> Self {
        Self {
            effect: Effect::Deny,
            reason: reason.into(),
            matched_rule: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolSchemaProfile {
    Bridge,
    Codex,
}

impl Default for ToolSchemaProfile {
    fn default() -> Self {
        Self::Bridge
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    #[serde(default)]
    pub allow_private_network: bool,
    #[serde(default = "default_timeout")]
    pub default_timeout_ms: u64,
    #[serde(default = "default_max_output")]
    pub max_output_chars: usize,
    #[serde(default = "default_shell")]
    pub default_shell: String,
    #[serde(default)]
    pub tool_schema: ToolSchemaProfile,
}

fn default_timeout() -> u64 {
    60_000
}

fn default_max_output() -> usize {
    20_000
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell".into()
    } else {
        "sh".into()
    }
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            revision: 0,
            rules: vec![
                Rule {
                    tool: "fs.list_dir".into(),
                    effect: Effect::Allow,
                    when: None,
                    note: None,
                },
                Rule {
                    tool: "fs.search".into(),
                    effect: Effect::Allow,
                    when: None,
                    note: None,
                },
                Rule {
                    tool: "fs.read_file".into(),
                    effect: Effect::Ask,
                    when: None,
                    note: None,
                },
                Rule {
                    tool: "fs.write_file".into(),
                    effect: Effect::Ask,
                    when: None,
                    note: None,
                },
                Rule {
                    tool: "shell.exec".into(),
                    effect: Effect::Ask,
                    when: None,
                    note: None,
                },
                Rule {
                    tool: "http.request".into(),
                    effect: Effect::Ask,
                    when: None,
                    note: None,
                },
                Rule {
                    tool: "read_file".into(),
                    effect: Effect::Ask,
                    when: None,
                    note: Some("Codex schema".into()),
                },
                Rule {
                    tool: "list_dir".into(),
                    effect: Effect::Allow,
                    when: None,
                    note: Some("Codex schema".into()),
                },
                Rule {
                    tool: "exec".into(),
                    effect: Effect::Ask,
                    when: None,
                    note: Some("Codex schema".into()),
                },
                Rule {
                    tool: "unified_exec".into(),
                    effect: Effect::Ask,
                    when: None,
                    note: Some("Codex schema".into()),
                },
                Rule {
                    tool: "apply_patch".into(),
                    effect: Effect::Ask,
                    when: None,
                    note: Some("Codex schema".into()),
                },
            ],
            roots: Vec::new(),
            allowed_hosts: Vec::new(),
            allow_private_network: false,
            default_timeout_ms: default_timeout(),
            max_output_chars: default_max_output(),
            default_shell: default_shell(),
            tool_schema: ToolSchemaProfile::Bridge,
        }
    }
}

const DESTRUCTIVE_PATTERNS: &[(&str, &str)] = &[
    (
        r"(?i)\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]",
        "recursive/forced file deletion (`rm -rf`)",
    ),
    (r"(?i)\bmkfs(\.\w+)?\b", "filesystem formatting"),
    (r"(?i)\bdd\s+.*\bof=/dev/", "raw device writes"),
    (r"(?i)>\s*/dev/(sd|nvme|hd)", "raw device redirection"),
    (r"(?i)\bformat\s+[a-z]:", "Windows volume formatting"),
    (r"(?i)\bdiskpart\b", "Windows disk partitioning"),
    (
        r"(?i)\b(del|erase)\s+.*(/s|/q)",
        "recursive/quiet Windows deletion",
    ),
    (
        r"(?i)\b(shutdown|restart|reboot)\b",
        "system shutdown/restart",
    ),
    (r"(?i):\(\)\s*\{.*:\|:.*\};", "fork bomb"),
];

pub struct PolicyEngine {
    policy: Policy,
    sandbox: Sandbox,
    allowed_hosts: GlobSet,
    destructive: Vec<(Regex, &'static str)>,
}

impl PolicyEngine {
    pub fn new(policy: Policy) -> Result<Self> {
        let sandbox = Sandbox::new(policy.roots.iter().map(std::path::PathBuf::from));
        let mut builder = GlobSetBuilder::new();
        for host in &policy.allowed_hosts {
            builder.add(Glob::new(host).map_err(|e| {
                BridgeError::invalid_params(format!("Invalid host glob `{host}`: {e}"))
            })?);
        }
        let allowed_hosts = builder
            .build()
            .map_err(|e| BridgeError::invalid_params(format!("Invalid host allowlist: {e}")))?;
        let destructive = DESTRUCTIVE_PATTERNS
            .iter()
            .map(|(pattern, name)| {
                Ok((
                    Regex::new(pattern).map_err(|e| BridgeError::internal(e.to_string()))?,
                    *name,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            policy,
            sandbox,
            allowed_hosts,
            destructive,
        })
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
    }
    pub fn sandbox(&self) -> &Sandbox {
        &self.sandbox
    }
    pub fn roots(&self) -> &[String] {
        &self.policy.roots
    }
    pub fn allowed_hosts(&self) -> &[String] {
        &self.policy.allowed_hosts
    }
    pub fn allow_private_network(&self) -> bool {
        self.policy.allow_private_network
    }
    pub fn default_timeout_ms(&self) -> u64 {
        self.policy.default_timeout_ms
    }
    pub fn max_output_chars(&self) -> usize {
        self.policy.max_output_chars
    }
    pub fn default_shell(&self) -> &str {
        &self.policy.default_shell
    }
    pub fn tool_schema(&self) -> ToolSchemaProfile {
        self.policy.tool_schema
    }

    pub fn evaluate(&self, tool: &str, args: &serde_json::Value, default: Effect) -> Verdict {
        let command = args
            .get("command")
            .and_then(serde_json::Value::as_str)
            .or_else(|| args.get("cmd").and_then(serde_json::Value::as_str))
            .unwrap_or_default();

        if (tool == "shell.exec" || tool == "exec" || tool == "unified_exec")
            && self
                .destructive
                .iter()
                .any(|(regex, _)| regex.is_match(command))
        {
            let reason = self
                .destructive
                .iter()
                .find(|(regex, _)| regex.is_match(command))
                .map(|(_, name)| *name)
                .unwrap_or("destructive command");
            return Verdict::deny(format!("Command rejected by safety denylist: {reason}"));
        }

        for (index, rule) in self.policy.rules.iter().enumerate() {
            if rule.tool != tool {
                continue;
            }
            if let Some(predicate) = &rule.when {
                if !predicate.path_within.is_empty() {
                    let Some(path) = args.get("path").and_then(serde_json::Value::as_str) else {
                        continue;
                    };
                    if !predicate
                        .path_within
                        .iter()
                        .any(|root| path.starts_with(root))
                    {
                        continue;
                    }
                }
                if !predicate.host_in.is_empty() {
                    let Some(host) = args.get("url").and_then(serde_json::Value::as_str) else {
                        continue;
                    };
                    if !predicate
                        .host_in
                        .iter()
                        .any(|allowed| host.contains(allowed))
                    {
                        continue;
                    }
                }
                if !predicate.command_not_matches.is_empty()
                    && predicate.command_not_matches.iter().any(|pattern| {
                        Regex::new(pattern)
                            .map(|regex| regex.is_match(command))
                            .unwrap_or(false)
                    })
                {
                    continue;
                }
            }
            return Verdict {
                effect: rule.effect,
                reason: rule
                    .note
                    .clone()
                    .unwrap_or_else(|| format!("Matched rule #{}", index + 1)),
                matched_rule: Some(format!("#{}", index + 1)),
            };
        }

        Verdict {
            effect: default,
            reason: "No policy rule matched; using tool default".into(),
            matched_rule: None,
        }
    }

    pub fn host_allowed(&self, host: &str) -> bool {
        self.allowed_hosts.is_match(host)
    }
}

/// Returns true for loopback, private, link-local, unspecified, multicast,
/// and local-domain targets. DNS resolution is deliberately not performed here;
/// this is a syntactic safety gate before the HTTP client connects.
pub fn is_private_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") {
        return true;
    }

    let Ok(ip) = host.parse::<std::net::IpAddr>() else {
        return false;
    };

    match ip {
        std::net::IpAddr::V4(ip) => {
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
        }
        std::net::IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
        }
    }
}

/// Match a hostname against the same glob syntax used by the policy allowlist.
pub fn host_matches(pattern: &str, host: &str) -> bool {
    Glob::new(pattern)
        .map(|glob| glob.compile_matcher().is_match(host))
        .unwrap_or(false)
}
