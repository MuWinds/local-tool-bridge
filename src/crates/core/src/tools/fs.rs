//! Filesystem tool implementations.
//!
//! These are internal: the client-facing `read_file` and `list_dir` tools in
//! `codex` wrap them. Both go through `PolicyEngine::sandbox()`, so path
//! confinement and the denylist are enforced here rather than in each handler's
//! own ad-hoc checks.

use std::time::Instant;

use serde_json::{Value, json};

use super::{
    Tool, ToolContext, ToolDescriptor, ToolOutput, clamp_u64, optional_bool, optional_str,
    optional_u64, required_str,
};
use crate::error::{BridgeError, Result};

/// Refuse files that are almost certainly not text, rather than returning
/// megabytes of mojibake to the model.
const BINARY_SNIFF_BYTES: usize = 8192;

fn schema(properties: Value, required: &[&str]) -> super::ObjectSchema {
    super::ObjectSchema {
        schema_type: "object".into(),
        properties: serde_json::from_value(properties)
            .expect("schema properties must be an object"),
        required: required.iter().map(|s| (*s).to_string()).collect(),
    }
}

/// `fs.read_file`
pub struct ReadFile;

#[async_trait::async_trait]
impl Tool for ReadFile {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "fs.read_file".into(),
            summary: "Read a UTF-8 text file from disk".into(),
            description: "Reads a file and returns its contents. By default output is prefixed \
                          with line numbers, which also normalises line endings; pass \
                          `lineNumbers: false` to get the file byte-for-byte. Use `offset` and \
                          `limit` for large files. Binary files are refused rather than mangled."
                .into(),
            category: "fs".into(),
            mutating: false,
            default_effect: super::DefaultEffect::Ask,
            latency_hint: "instant".into(),
            input_schema: schema(
                json!({
                    "path": { "type": "string", "description": "Absolute path to the file" },
                    "offset": {
                        "type": "integer",
                        "description": "1-based first line to return",
                        "minimum": 1,
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of lines",
                        "minimum": 1,
                        "maximum": 5000,
                    },
                    "lineNumbers": {
                        "type": "boolean",
                        "description": "Prefix each line with its number (normalises line endings)",
                        "default": true,
                    },
                    "encoding": {
                        "type": "string",
                        "enum": ["utf-8", "utf-16le", "gbk"],
                        "default": "utf-8",
                    },
                }),
                &["path"],
            ),
        }
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        let started = Instant::now();
        let raw_path = required_str(&arguments, "path")?;
        let path = context.policy.sandbox().resolve(&raw_path, true)?;

        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|error| BridgeError::from_io("Failed to stat file", error))?;
        if metadata.is_dir() {
            return Err(BridgeError::invalid_params(format!(
                "`{}` is a directory; use fs.list_dir instead",
                path.display()
            )));
        }

        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| BridgeError::from_io("Failed to read file", error))?;

        if looks_binary(&bytes) {
            return Ok(ToolOutput::error(format!(
                "Refused to read `{}`: it appears to be a binary file ({} bytes)",
                path.display(),
                bytes.len()
            )));
        }

        let encoding = optional_str(&arguments, "encoding").unwrap_or_else(|| "utf-8".into());
        let text = decode(&bytes, &encoding).map_err(|error| {
            BridgeError::invalid_params(format!("Failed to decode as {encoding}: {error}"))
        })?;

        let line_numbers = optional_bool(&arguments, "lineNumbers", true);
        let offset = optional_u64(&arguments, "offset", 1).max(1) as usize;
        let limit = clamp_u64(optional_u64(&arguments, "limit", 2000), 1, 5000) as usize;

        // `split_inclusive` keeps each line's own terminator, so a file's line
        // endings survive the round trip. Using `lines()` here would silently
        // rewrite CRLF to LF and drop a missing final newline — which matters
        // when the model reads a file and writes it back.
        let lines: Vec<&str> = text.split_inclusive('\n').collect();
        let total_lines = lines.len();
        let start_index = (offset - 1).min(total_lines);
        let end_index = (start_index + limit).min(total_lines);

        let body = if line_numbers {
            let mut body = String::new();
            for (index, line) in lines[start_index..end_index].iter().enumerate() {
                // The terminator is stripped for display only; the numbering
                // gutter would otherwise be pushed off by a stray `\r`.
                let shown = line.strip_suffix('\n').unwrap_or(line);
                let shown = shown.strip_suffix('\r').unwrap_or(shown);
                body.push_str(&format!("{:>6}\t{shown}\n", start_index + index + 1));
            }
            body
        } else {
            lines[start_index..end_index].concat()
        };

        let header = if line_numbers {
            format!(
                "{} ({} lines total, showing {}-{})\n",
                path.display(),
                total_lines,
                if total_lines == 0 { 0 } else { start_index + 1 },
                end_index
            )
        } else {
            // Without a gutter there is no header: the caller asked for the file
            // itself, and any prefix would corrupt it.
            String::new()
        };

        Ok(ToolOutput {
            content: vec![super::ContentBlock::text(format!("{header}{body}"))],
            is_error: false,
            truncated: end_index < total_lines,
            original_bytes: Some(bytes.len()),
            duration_ms: Some(started.elapsed().as_millis() as u64),
        })
    }
}

/// Heuristic binary detection: a NUL byte in the first few KiB.
fn looks_binary(bytes: &[u8]) -> bool {
    let window = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    window.contains(&0)
}

/// Decodes bytes with the requested encoding, returning a human-readable error.
fn decode(bytes: &[u8], encoding: &str) -> std::result::Result<String, String> {
    match encoding.to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" => String::from_utf8(bytes.to_vec())
            .map_err(|error| format!("invalid UTF-8 at byte {}", error.utf8_error().valid_up_to())),
        "utf-16le" | "utf16le" => {
            if !bytes.len().is_multiple_of(2) {
                return Err("odd byte count for UTF-16LE".into());
            }
            let units: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16(&units).map_err(|error| error.to_string())
        }
        "gbk" => Err("GBK decoding is not compiled in; convert the file to UTF-8 first".into()),
        other => Err(format!("Unsupported encoding `{other}`")),
    }
}

/// `fs.list_dir`
pub struct ListDir;

#[async_trait::async_trait]
impl Tool for ListDir {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "fs.list_dir".into(),
            summary: "List the entries of a directory".into(),
            description: "Returns names, sizes, and modification times for a directory. \
                          Non-recursive by default; set `recursive` with a `glob` to walk a tree."
                .into(),
            category: "fs".into(),
            mutating: false,
            default_effect: super::DefaultEffect::Allow,
            latency_hint: "instant".into(),
            input_schema: schema(
                json!({
                    "path": { "type": "string", "description": "Absolute directory path" },
                    "recursive": { "type": "boolean", "default": false },
                    "glob": { "type": "string", "description": "Filter such as `**/*.ts`" },
                    "includeHidden": { "type": "boolean", "default": false },
                    "maxEntries": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 5000,
                        "default": 500,
                    },
                }),
                &["path"],
            ),
        }
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        let started = Instant::now();
        let raw_path = required_str(&arguments, "path")?;
        let root = context.policy.sandbox().resolve(&raw_path, true)?;

        if !root.is_dir() {
            return Err(BridgeError::invalid_params(format!(
                "`{}` is not a directory",
                root.display()
            )));
        }

        let recursive = optional_bool(&arguments, "recursive", false);
        let include_hidden = optional_bool(&arguments, "includeHidden", false);
        let max_entries = clamp_u64(optional_u64(&arguments, "maxEntries", 500), 1, 5000) as usize;

        let filter = match optional_str(&arguments, "glob") {
            Some(pattern) => Some(
                globset::Glob::new(&pattern)
                    .map_err(|error| BridgeError::invalid_params(format!("Invalid glob: {error}")))?
                    .compile_matcher(),
            ),
            None => None,
        };

        let mut lines: Vec<String> = Vec::new();
        let mut count = 0usize;
        let mut hit_limit = false;

        if recursive {
            // `max_depth` is unbounded on purpose: the entry cap is what bounds
            // the walk, so a deep tree still terminates promptly.
            let walker = walkdir::WalkDir::new(&root).follow_links(false).into_iter();
            for entry in walker.filter_entry(|entry| include_hidden || !is_hidden(entry.path())) {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => continue,
                };
                if entry.path() == root {
                    continue;
                }
                if let Some(matcher) = &filter {
                    let relative = entry.path().strip_prefix(&root).unwrap_or(entry.path());
                    if !matcher.is_match(relative) {
                        continue;
                    }
                }
                if count >= max_entries {
                    hit_limit = true;
                    break;
                }
                lines.push(describe_entry(
                    entry.path(),
                    entry.file_type().is_dir(),
                    &root,
                ));
                count += 1;
            }
        } else {
            let mut reader = tokio::fs::read_dir(&root)
                .await
                .map_err(|error| BridgeError::from_io("Failed to read directory", error))?;
            while let Some(entry) = reader
                .next_entry()
                .await
                .map_err(|error| BridgeError::from_io("Failed to read directory entry", error))?
            {
                let path = entry.path();
                if !include_hidden && is_hidden(&path) {
                    continue;
                }
                if let Some(matcher) = &filter {
                    let name = entry.file_name();
                    if !matcher.is_match(std::path::Path::new(&name)) {
                        continue;
                    }
                }
                if count >= max_entries {
                    hit_limit = true;
                    break;
                }
                let is_dir = entry
                    .file_type()
                    .await
                    .map(|kind| kind.is_dir())
                    .unwrap_or(false);
                lines.push(describe_entry(&path, is_dir, &root));
                count += 1;
            }
        }

        lines.sort();
        let header = format!(
            "{} — {} entr{}{}\n",
            root.display(),
            count,
            if count == 1 { "y" } else { "ies" },
            if hit_limit {
                " (truncated at maxEntries)"
            } else {
                ""
            }
        );

        Ok(ToolOutput {
            content: vec![super::ContentBlock::text(format!(
                "{header}{}",
                lines.join("\n")
            ))],
            is_error: false,
            truncated: hit_limit,
            original_bytes: None,
            duration_ms: Some(started.elapsed().as_millis() as u64),
        })
    }
}

fn is_hidden(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with('.') && name != "." && name != "..")
        .unwrap_or(false)
}

fn describe_entry(path: &std::path::Path, is_dir: bool, root: &std::path::Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let display = relative.display();
    if is_dir {
        return format!("{display}/");
    }
    match std::fs::metadata(path) {
        Ok(metadata) => format!("{display}\t{} bytes", metadata.len()),
        Err(_) => format!("{display}\t?"),
    }
}
