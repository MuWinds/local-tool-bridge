//! Filesystem tools.
//!
//! All four go through `PolicyEngine::sandbox()`, so path confinement and the
//! denylist are enforced here rather than in each handler's own ad-hoc checks.

use std::time::Instant;

use serde_json::{json, Value};

use super::{
    clamp_u64, optional_bool, optional_str, optional_u64, required_str, Tool, ToolContext,
    ToolDescriptor, ToolOutput,
};
use crate::error::{BridgeError, Result};
use crate::policy::path::lexical_normalize;

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
            description: "Reads a file and returns its contents. By default output is prefixed with line numbers, which also normalises line endings; pass `lineNumbers: false` to get the file byte-for-byte. Use `offset` and `limit` for large files. Binary files are refused rather than mangled.".into(),
            category: "fs".into(),
            mutating: false,
            default_effect: super::DefaultEffect::Ask,
            latency_hint: "instant".into(),
            input_schema: schema(
                json!({
                    "path": { "type": "string", "description": "Absolute path to the file" },
                    "offset": { "type": "integer", "description": "1-based first line to return", "minimum": 1 },
                    "limit": { "type": "integer", "description": "Maximum number of lines", "minimum": 1, "maximum": 5000 },
                    "lineNumbers": { "type": "boolean", "description": "Prefix each line with its number (normalises line endings)", "default": true },
                    "encoding": { "type": "string", "enum": ["utf-8", "utf-16le", "gbk"], "default": "utf-8" }
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
            if bytes.len() % 2 != 0 {
                return Err("odd byte count for UTF-16LE".into());
            }
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16(&units).map_err(|error| error.to_string())
        }
        "gbk" => Err("GBK decoding is not compiled in; convert the file to UTF-8 first".into()),
        other => Err(format!("Unsupported encoding `{other}`")),
    }
}

/// `fs.write_file`
pub struct WriteFile;

#[async_trait::async_trait]
impl Tool for WriteFile {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "fs.write_file".into(),
            summary: "Create or overwrite a text file".into(),
            description: "Writes text to a file, creating parent directories when needed. Always requires explicit human approval because it destroys existing content unless `mode` is `append`.".into(),
            category: "fs".into(),
            mutating: true,
            default_effect: super::DefaultEffect::Ask,
            latency_hint: "instant".into(),
            input_schema: schema(
                json!({
                    "path": { "type": "string", "description": "Absolute path to write" },
                    "content": { "type": "string", "description": "Full file contents" },
                    "mode": { "type": "string", "enum": ["overwrite", "append", "create"], "default": "overwrite" },
                    "createDirs": { "type": "boolean", "description": "Create missing parent directories", "default": true }
                }),
                &["path", "content"],
            ),
        }
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        let started = Instant::now();
        let raw_path = required_str(&arguments, "path")?;
        let content = required_str(&arguments, "content")?;
        let mode = optional_str(&arguments, "mode").unwrap_or_else(|| "overwrite".into());
        let create_dirs = optional_bool(&arguments, "createDirs", true);

        let path = context.policy.sandbox().resolve(&raw_path, false)?;

        if create_dirs {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|error| {
                    BridgeError::from_io("Failed to create parent directories", error)
                })?;
            }
        }

        let existed_before = path.exists();
        let bytes_written = content.len();

        match mode.as_str() {
            "overwrite" => {
                tokio::fs::write(&path, content.as_bytes())
                    .await
                    .map_err(|error| BridgeError::from_io("Failed to write file", error))?;
            }
            "append" => {
                use tokio::io::AsyncWriteExt;
                let mut file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .await
                    .map_err(|error| {
                        BridgeError::from_io("Failed to open file for append", error)
                    })?;
                file.write_all(content.as_bytes())
                    .await
                    .map_err(|error| BridgeError::from_io("Failed to append to file", error))?;
                file.flush()
                    .await
                    .map_err(|error| BridgeError::from_io("Failed to flush file", error))?;
            }
            "create" => {
                if existed_before {
                    return Err(BridgeError::new(
                        crate::error::code::TOOL_DENIED,
                        format!("Refusing to create `{}`: it already exists", path.display()),
                    ));
                }
                tokio::fs::write(&path, content.as_bytes())
                    .await
                    .map_err(|error| BridgeError::from_io("Failed to create file", error))?;
            }
            other => {
                return Err(BridgeError::invalid_params(format!(
                    "Unsupported mode `{other}`; expected overwrite, append, or create"
                )))
            }
        }

        let verb = if existed_before { "Updated" } else { "Created" };
        Ok(ToolOutput {
            content: vec![super::ContentBlock::text(format!(
                "{verb} {} ({} bytes, mode={mode})",
                path.display(),
                bytes_written
            ))],
            is_error: false,
            truncated: false,
            original_bytes: None,
            duration_ms: Some(started.elapsed().as_millis() as u64),
        })
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
            description: "Returns names, sizes, and modification times for a directory. Non-recursive by default; set `recursive` with a `glob` to walk a tree.".into(),
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
                    "maxEntries": { "type": "integer", "minimum": 1, "maximum": 5000, "default": 500 }
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

/// `fs.search`
pub struct Search;

#[async_trait::async_trait]
impl Tool for Search {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "fs.search".into(),
            summary: "Search file contents with a regular expression".into(),
            description: "Recursively searches text files under a directory and returns matching lines with their line numbers. Skips binary files, `.git`, and `node_modules` by default.".into(),
            category: "fs".into(),
            mutating: false,
            default_effect: super::DefaultEffect::Allow,
            latency_hint: "slow".into(),
            input_schema: schema(
                json!({
                    "path": { "type": "string", "description": "Absolute directory to search" },
                    "pattern": { "type": "string", "description": "Rust regex syntax" },
                    "glob": { "type": "string", "description": "Restrict to matching files, e.g. `*.rs`" },
                    "ignoreCase": { "type": "boolean", "default": false },
                    "maxResults": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    "contextLines": { "type": "integer", "minimum": 0, "maximum": 10, "default": 0 }
                }),
                &["path", "pattern"],
            ),
        }
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        let started = Instant::now();
        let raw_path = required_str(&arguments, "path")?;
        let root = context.policy.sandbox().resolve(&raw_path, true)?;
        let pattern = required_str(&arguments, "pattern")?;
        let ignore_case = optional_bool(&arguments, "ignoreCase", false);
        let max_results = clamp_u64(optional_u64(&arguments, "maxResults", 100), 1, 1000) as usize;
        let context_lines = clamp_u64(optional_u64(&arguments, "contextLines", 0), 0, 10) as usize;

        let regex = regex::RegexBuilder::new(&pattern)
            .case_insensitive(ignore_case)
            .build()
            .map_err(|error| BridgeError::invalid_params(format!("Invalid regex: {error}")))?;

        let filter = match optional_str(&arguments, "glob") {
            Some(pattern) => Some(
                globset::Glob::new(&pattern)
                    .map_err(|error| BridgeError::invalid_params(format!("Invalid glob: {error}")))?
                    .compile_matcher(),
            ),
            None => None,
        };

        // Directories that would otherwise dominate the results with noise.
        const SKIP_DIRS: &[&str] = &[
            ".git",
            "node_modules",
            "target",
            "dist",
            "build",
            ".venv",
            "__pycache__",
        ];
        const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

        let mut results: Vec<String> = Vec::new();
        let mut files_scanned = 0usize;
        let mut truncated = false;

        let walker = walkdir::WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                let name = entry.file_name().to_string_lossy();
                !(entry.file_type().is_dir() && SKIP_DIRS.iter().any(|skip| name == *skip))
            });

        'outer: for entry in walker {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();

            if let Some(matcher) = &filter {
                let relative = path.strip_prefix(&root).unwrap_or(path);
                if !matcher.is_match(relative) {
                    continue;
                }
            }
            if let Ok(metadata) = entry.metadata() {
                if metadata.len() > MAX_FILE_BYTES {
                    continue;
                }
            }

            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            if looks_binary(&bytes) {
                continue;
            }
            let Ok(text) = String::from_utf8(bytes) else {
                continue;
            };

            files_scanned += 1;
            let lines: Vec<&str> = text.lines().collect();

            for (index, line) in lines.iter().enumerate() {
                if !regex.is_match(line) {
                    continue;
                }
                if results.len() >= max_results {
                    truncated = true;
                    break 'outer;
                }

                let relative = path
                    .strip_prefix(&root)
                    .unwrap_or(path)
                    .display()
                    .to_string();
                let line_number = index + 1;

                if context_lines > 0 {
                    let from = index.saturating_sub(context_lines);
                    let to = (index + context_lines + 1).min(lines.len());
                    for (context_index, context_line) in lines[from..to].iter().enumerate() {
                        let actual = from + context_index + 1;
                        let marker = if actual == line_number { ':' } else { '-' };
                        results.push(format!("{relative}{marker}{actual}{marker}{context_line}"));
                    }
                } else {
                    results.push(format!("{relative}:{line_number}:{line}"));
                }
            }
        }

        let header = format!(
            "{} match{} across {files_scanned} file{}{}\n",
            results.len(),
            if results.len() == 1 { "" } else { "es" },
            if files_scanned == 1 { "" } else { "s" },
            if truncated {
                " (truncated at maxResults)"
            } else {
                ""
            }
        );

        Ok(ToolOutput {
            content: vec![super::ContentBlock::text(format!(
                "{header}{}",
                results.join("\n")
            ))],
            is_error: false,
            truncated,
            original_bytes: None,
            duration_ms: Some(started.elapsed().as_millis() as u64),
        })
    }
}

/// Exposed for the shell tool, which needs the same normalisation.
pub fn normalize_for_display(path: &std::path::Path) -> String {
    lexical_normalize(path).display().to_string()
}
