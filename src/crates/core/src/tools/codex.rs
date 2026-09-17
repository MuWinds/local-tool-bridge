//! Codex-compatible tool schemas layered on top of the existing bridge tools.
//!
//! The implementations deliberately delegate to the existing filesystem/shell
//! tools wherever the semantics overlap. This keeps policy, sandboxing, audit,
//! output limits, and platform shell selection in one place.

use std::time::Instant;

use serde_json::{json, Value};

use super::{required_str, Tool, ToolContext, ToolDescriptor, ToolOutput};
use crate::error::{BridgeError, Result};

fn object_schema(properties: Value, required: &[&str]) -> super::ObjectSchema {
    super::ObjectSchema {
        schema_type: "object".into(),
        properties: serde_json::from_value(properties)
            .expect("schema properties must be an object"),
        required: required.iter().map(|s| (*s).to_string()).collect(),
    }
}

/// A thin compatibility wrapper for Codex's `read_file` schema.
pub struct ReadFile;

#[async_trait::async_trait]
impl Tool for ReadFile {
    fn descriptor(&self) -> ToolDescriptor {
        let mut descriptor = super::fs::ReadFile.descriptor();
        descriptor.name = "read_file".into();
        descriptor.summary = "Read a UTF-8 text file from disk (Codex schema)".into();
        descriptor.description =
            "Reads a file using the bridge's existing filesystem sandbox and encoding support."
                .into();
        descriptor.category = "codex-filesystem".into();
        descriptor
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        super::fs::ReadFile.execute(arguments, context).await
    }
}

/// A thin compatibility wrapper for Codex's `list_dir` schema.
pub struct ListDir;

#[async_trait::async_trait]
impl Tool for ListDir {
    fn descriptor(&self) -> ToolDescriptor {
        let mut descriptor = super::fs::ListDir.descriptor();
        descriptor.name = "list_dir".into();
        descriptor.summary = "List directory entries (Codex schema)".into();
        descriptor.description =
            "Lists directory entries using the bridge's existing filesystem sandbox.".into();
        descriptor.category = "codex-filesystem".into();
        descriptor
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        super::fs::ListDir.execute(arguments, context).await
    }
}

/// Codex-shaped one-shot execution tool. It reuses the bridge shell executor.
pub struct Exec;

#[async_trait::async_trait]
impl Tool for Exec {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "exec".into(),
            summary: "Run a command using the configured shell".into(),
            description: "Codex-compatible command execution schema. The bridge keeps shell selection under its GUI policy; the optional shell field is accepted for schema compatibility but cannot override the configured shell.".into(),
            category: "codex-execution".into(),
            mutating: true,
            default_effect: super::DefaultEffect::Ask,
            latency_hint: "slow".into(),
            input_schema: object_schema(json!({
                "cmd": { "type": "string", "description": "Command line to execute" },
                "shell": { "type": "string", "description": "Compatibility field; shell is selected by the bridge policy" },
                "login": { "type": "boolean", "default": true },
                "tty": { "type": "boolean", "default": false },
                "yield_time_ms": { "type": "integer", "minimum": 0, "maximum": 600000, "default": 10000 },
                "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 600000 },
                "max_output_tokens": { "type": "integer", "minimum": 1, "maximum": 100000 },
                "cwd": { "type": "string", "description": "Absolute working directory" },
                "env": { "type": "object", "description": "Extra environment variables" }
            }), &["cmd"]),
        }
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        let cmd = required_str(&arguments, "cmd")?;
        let mut translated = arguments.clone();
        if let Some(object) = translated.as_object_mut() {
            object.insert("command".into(), Value::String(cmd));
            if let Some(timeout) = object.get("timeout_ms").cloned() {
                object.insert("timeoutMs".into(), timeout);
            }
        }
        super::shell::Exec.execute(translated, context).await
    }
}

/// Alias for the same execution path. The bridge currently keeps the process
/// model intentionally simple and reuses the existing shell executor.
pub struct UnifiedExec;

#[async_trait::async_trait]
impl Tool for UnifiedExec {
    fn descriptor(&self) -> ToolDescriptor {
        let mut descriptor = Exec.descriptor();
        descriptor.name = "unified_exec".into();
        descriptor.summary = "Run a command through the unified exec schema".into();
        descriptor.description = "Codex unified-exec compatible schema backed by the bridge's existing shell executor and policy controls.".into();
        descriptor
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        Exec.execute(arguments, context).await
    }
}

/// Codex's free-form patch tool. It intentionally has its own parser so patch
/// semantics do not depend on shell quoting or platform-specific utilities.
pub struct ApplyPatch;

#[async_trait::async_trait]
impl Tool for ApplyPatch {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "apply_patch".into(),
            summary: "Create, update, delete, or move files with a patch".into(),
            description: "Applies the Codex file-oriented patch format directly to the sandboxed filesystem. Supported operations are Add File, Delete File, Update File, and Update File with Move to.".into(),
            category: "codex-filesystem".into(),
            mutating: true,
            default_effect: super::DefaultEffect::Ask,
            latency_hint: "instant".into(),
            input_schema: object_schema(json!({
                "patch": { "type": "string", "description": "A Codex apply_patch document beginning with *** Begin Patch and ending with *** End Patch" }
            }), &["patch"]),
        }
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        let started = Instant::now();
        let patch = required_str(&arguments, "patch")?;
        let changes = parse_patch(&patch)?;
        if changes.is_empty() {
            return Err(BridgeError::invalid_params(
                "Patch contains no file operations",
            ));
        }

        let mut applied = Vec::new();
        for change in changes {
            match change {
                PatchChange::Add { path, content } => {
                    let path = context.policy.sandbox().resolve(&path, false)?;
                    if path.exists() {
                        return Err(BridgeError::invalid_params(format!(
                            "Cannot add `{}`: file already exists",
                            path.display()
                        )));
                    }
                    if let Some(parent) = path.parent() {
                        tokio::fs::create_dir_all(parent).await.map_err(|e| {
                            BridgeError::from_io("Failed to create patch parent", e)
                        })?;
                    }
                    tokio::fs::write(&path, content)
                        .await
                        .map_err(|e| BridgeError::from_io("Failed to add file", e))?;
                    applied.push(format!("A {}", path.display()));
                }
                PatchChange::Delete { path } => {
                    let path = context.policy.sandbox().resolve(&path, false)?;
                    if path.is_dir() {
                        return Err(BridgeError::invalid_params(format!(
                            "Cannot delete directory `{}` with apply_patch",
                            path.display()
                        )));
                    }
                    tokio::fs::remove_file(&path)
                        .await
                        .map_err(|e| BridgeError::from_io("Failed to delete file", e))?;
                    applied.push(format!("D {}", path.display()));
                }
                PatchChange::Update {
                    path,
                    move_to,
                    hunks,
                } => {
                    let path = context.policy.sandbox().resolve(&path, false)?;
                    let original = tokio::fs::read_to_string(&path)
                        .await
                        .map_err(|e| BridgeError::from_io("Failed to read patch target", e))?;
                    let updated = apply_hunks(&original, &hunks)?;
                    let target = if let Some(move_to) = move_to {
                        context.policy.sandbox().resolve(&move_to, false)?
                    } else {
                        path.clone()
                    };
                    if let Some(parent) = target.parent() {
                        tokio::fs::create_dir_all(parent).await.map_err(|e| {
                            BridgeError::from_io("Failed to create patch target parent", e)
                        })?;
                    }
                    tokio::fs::write(&target, updated)
                        .await
                        .map_err(|e| BridgeError::from_io("Failed to write patched file", e))?;
                    if target != path {
                        tokio::fs::remove_file(&path).await.map_err(|e| {
                            BridgeError::from_io("Failed to remove moved source", e)
                        })?;
                    }
                    applied.push(format!(
                        "U {}{}",
                        path.display(),
                        if target != path {
                            format!(" -> {}", target.display())
                        } else {
                            String::new()
                        }
                    ));
                }
            }
        }

        Ok(ToolOutput {
            content: vec![super::ContentBlock::text(format!(
                "Applied {} patch operation(s) in {} ms:\n{}",
                applied.len(),
                started.elapsed().as_millis(),
                applied.join("\n")
            ))],
            is_error: false,
            truncated: false,
            original_bytes: None,
            duration_ms: Some(started.elapsed().as_millis() as u64),
        })
    }
}

#[derive(Debug)]
enum PatchChange {
    Add {
        path: String,
        content: Vec<u8>,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_to: Option<String>,
        hunks: Vec<Vec<String>>,
    },
}

fn parse_patch(patch: &str) -> Result<Vec<PatchChange>> {
    let lines: Vec<&str> = patch.lines().collect();
    if lines.first().copied() != Some("*** Begin Patch")
        || lines.last().copied() != Some("*** End Patch")
    {
        return Err(BridgeError::invalid_params(
            "Invalid apply_patch envelope; expected *** Begin Patch / *** End Patch",
        ));
    }
    let mut i = 1;
    let mut changes = Vec::new();
    while i + 1 < lines.len() {
        let header = lines[i];
        if let Some(path) = header.strip_prefix("*** Add File: ") {
            i += 1;
            let mut content = String::new();
            while i + 1 < lines.len() && !lines[i].starts_with("*** ") {
                let line = lines[i];
                if let Some(rest) = line.strip_prefix('+') {
                    content.push_str(rest);
                    content.push('\n');
                } else {
                    return Err(BridgeError::invalid_params(
                        "Add File lines must begin with `+`",
                    ));
                }
                i += 1;
            }
            changes.push(PatchChange::Add {
                path: path.trim().into(),
                content: content.into_bytes(),
            });
            continue;
        }
        if let Some(path) = header.strip_prefix("*** Delete File: ") {
            changes.push(PatchChange::Delete {
                path: path.trim().into(),
            });
            i += 1;
            continue;
        }
        if let Some(path) = header.strip_prefix("*** Update File: ") {
            let source = path.trim().to_string();
            i += 1;
            let mut move_to = None;
            if i + 1 < lines.len() && lines[i].starts_with("*** Move to: ") {
                move_to = Some(lines[i]["*** Move to: ".len()..].trim().to_string());
                i += 1;
            }
            let mut hunks = Vec::new();
            let mut current = Vec::new();
            while i + 1 < lines.len() && !lines[i].starts_with("*** ") {
                if lines[i].starts_with("@@") {
                    if !current.is_empty() {
                        hunks.push(std::mem::take(&mut current));
                    }
                } else {
                    current.push(lines[i].to_string());
                }
                i += 1;
            }
            if !current.is_empty() {
                hunks.push(current);
            }
            changes.push(PatchChange::Update {
                path: source,
                move_to,
                hunks,
            });
            continue;
        }
        return Err(BridgeError::invalid_params(format!(
            "Unknown apply_patch operation `{header}`"
        )));
    }
    Ok(changes)
}

fn apply_hunks(original: &str, hunks: &[Vec<String>]) -> Result<String> {
    let mut lines: Vec<String> = original.split_inclusive('\n').map(str::to_string).collect();
    if !original.is_empty() && !original.ends_with('\n') && lines.is_empty() {
        lines.push(original.to_string());
    }
    for hunk in hunks {
        let old: Vec<String> = hunk
            .iter()
            .filter_map(|line| line.strip_prefix(' ').or_else(|| line.strip_prefix('-')))
            .map(|s| format_with_original_ending(s, original))
            .collect();
        let new: Vec<String> = hunk
            .iter()
            .filter_map(|line| match line.chars().next() {
                Some(' ') | Some('+') => line.get(1..),
                _ => None,
            })
            .map(|s| format_with_original_ending(s, original))
            .collect();
        let pos = find_sequence(&lines, &old).ok_or_else(|| {
            BridgeError::invalid_params("Patch hunk context did not match the target file")
        })?;
        lines.splice(pos..pos + old.len(), new);
    }
    Ok(lines.concat())
}

fn format_with_original_ending(s: &str, original: &str) -> String {
    if original.contains("\r\n") {
        format!("{}\r\n", s.strip_suffix('\r').unwrap_or(s))
    } else {
        format!("{}\n", s)
    }
}

fn find_sequence(lines: &[String], needle: &[String]) -> Option<usize> {
    if needle.is_empty() {
        return Some(lines.len());
    }
    lines.windows(needle.len()).position(|window| {
        window
            .iter()
            .zip(needle)
            .all(|(a, b)| a.trim_end_matches(['\r', '\n']) == b.trim_end_matches(['\r', '\n']))
    })
}
