//! Append-only audit log.
//!
//! Every call that reaches the host is recorded, including the ones that were
//! denied. An audit trail that only records successes cannot answer the question
//! users actually ask ("what did it *try* to do?").
//!
//! The log is JSON Lines so it survives a crash mid-write and can be tailed
//! with ordinary tools. It is capped by size, with the oldest entries dropped,
//! so a long-running host cannot fill the disk.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::error::{BridgeError, Result};

/// How the call ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditOutcome {
    /// Executed successfully.
    Allowed,
    /// Refused by policy or the denylist.
    Denied,
    /// Approved by a human, then executed.
    Approved,
    /// The human declined.
    Rejected,
    /// Approval was requested and never answered.
    Expired,
    /// The tool ran but reported an error.
    Failed,
}

/// One audit record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// RFC 3339 timestamp.
    pub timestamp: String,
    pub call_id: String,
    pub tool: String,
    /// Redacted arguments, safe to display.
    pub arguments: serde_json::Value,
    pub outcome: AuditOutcome,
    /// Which policy rule decided it, when a rule did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

/// Maximum size of the on-disk log before the oldest lines are dropped.
const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

/// How many entries to keep in memory for the GUI's live view.
const MEMORY_RING_CAPACITY: usize = 500;

/// An append-only audit log with an in-memory ring for the GUI.
pub struct AuditLog {
    path: Option<PathBuf>,
    file: Mutex<Option<tokio::fs::File>>,
    ring: Mutex<std::collections::VecDeque<AuditEntry>>,
    enabled: bool,
}

impl AuditLog {
    /// Opens the log at `path`, creating parent directories as needed.
    pub async fn open(path: PathBuf, enabled: bool) -> Result<Self> {
        if !enabled {
            return Ok(Self {
                path: None,
                file: Mutex::new(None),
                ring: Mutex::new(std::collections::VecDeque::new()),
                enabled: false,
            });
        }

        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| BridgeError::from_io("Failed to create log directory", error))?;
        }

        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(|error| BridgeError::from_io("Failed to open audit log", error))?;

        Ok(Self {
            path: Some(path),
            file: Mutex::new(Some(file)),
            ring: Mutex::new(std::collections::VecDeque::with_capacity(
                MEMORY_RING_CAPACITY,
            )),
            enabled: true,
        })
    }

    /// A log that keeps entries in memory only, used by tests.
    pub fn in_memory() -> Self {
        Self {
            path: None,
            file: Mutex::new(None),
            ring: Mutex::new(std::collections::VecDeque::new()),
            enabled: true,
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Records one entry, rotating the file first when it has grown too large.
    pub async fn record(&self, entry: AuditEntry) {
        if !self.enabled {
            return;
        }

        {
            let mut ring = self.ring.lock().await;
            if ring.len() >= MEMORY_RING_CAPACITY {
                ring.pop_front();
            }
            ring.push_back(entry.clone());
        }

        let Some(path) = &self.path else { return };

        // Rotation is checked before each write. One metadata call per audit
        // entry is negligible next to the tool call it describes.
        let needs_rotation = tokio::fs::metadata(path)
            .await
            .map(|metadata| metadata.len() > MAX_LOG_BYTES)
            .unwrap_or(false);

        if needs_rotation {
            // Close the handle before rewriting the file, so the rewrite cannot
            // race with an append from this same log.
            {
                let mut guard = self.file.lock().await;
                if let Some(file) = guard.as_mut() {
                    let _ = file.flush().await;
                }
                *guard = None;
            }
            if let Err(error) = self.rotate().await {
                tracing::warn!(%error, "failed to rotate the audit log");
            }
        }

        let mut guard = self.file.lock().await;
        if guard.is_none() {
            *guard = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .await
                .ok();
        }
        if let Some(file) = guard.as_mut() {
            if let Err(error) = Self::write_entry(file, &entry).await {
                tracing::warn!(%error, "failed to append to the audit log");
            }
        }
    }

    async fn write_entry(file: &mut tokio::fs::File, entry: &AuditEntry) -> std::io::Result<()> {
        let mut line = serde_json::to_string(entry).unwrap_or_else(|_| "{}".into());
        line.push('\n');
        file.write_all(line.as_bytes()).await?;
        file.flush().await
    }

    /// Keeps the newest half of the log, discarding the oldest half.
    async fn rotate(&self) -> std::io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let content = tokio::fs::read_to_string(path).await.unwrap_or_default();

        let mut lines: Vec<&str> = content.lines().collect();
        let keep_from = lines.len() / 2;
        lines.drain(..keep_from);

        let mut rebuilt = lines.join("\n");
        if !rebuilt.is_empty() {
            rebuilt.push('\n');
        }
        tokio::fs::write(path, rebuilt).await
    }

    /// The most recent entries, newest last.
    pub async fn recent(&self, limit: usize) -> Vec<AuditEntry> {
        let ring = self.ring.lock().await;
        let skip = ring.len().saturating_sub(limit);
        ring.iter().skip(skip).cloned().collect()
    }
}

/// Keys whose values are replaced before an entry is written.
///
/// File *contents* are the argument most likely to contain a secret and the
/// least useful to replay in a log. The client-facing `apply_patch` carries them
/// under `patch`; the remaining keys are kept so a future tool that names a
/// credential field is covered without another audit-log change.
const REDACTED_KEYS: &[&str] = &[
    "patch",
    "content",
    "body",
    "stdin",
    "authorization",
    "apiKey",
    "token",
];

/// Replaces sensitive argument values with a size hint.
pub fn redact_arguments(arguments: &serde_json::Value) -> serde_json::Value {
    match arguments {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, value) in map {
                let lowered = key.to_ascii_lowercase();
                if REDACTED_KEYS
                    .iter()
                    .any(|candidate| lowered == candidate.to_ascii_lowercase())
                {
                    let size = value.as_str().map(str::len).unwrap_or(0);
                    out.insert(
                        key.clone(),
                        serde_json::json!(format!("<redacted {size} chars>")),
                    );
                } else {
                    out.insert(key.clone(), redact_arguments(value));
                }
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(redact_arguments).collect())
        }
        other => other.clone(),
    }
}

/// Formats a timestamp as RFC 3339 without pulling in a date-time crate.
pub fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();

    let days = secs / 86_400;
    let time_of_day = secs % 86_400;
    let (hour, minute, second) = (
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    );

    let (year, month, day) = civil_from_days(days as i64);

    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z",
        year = year,
        month = month,
        day = day,
    )
}

/// Converts days since the Unix epoch into a civil date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_hides_content_and_bodies() {
        let redacted = redact_arguments(&serde_json::json!({
            "path": "/tmp/a.txt",
            "content": "super secret",
            "nested": { "token": "abc123" }
        }));
        assert_eq!(redacted["path"], "/tmp/a.txt");
        assert!(redacted["content"].as_str().unwrap().contains("redacted"));
        assert!(
            redacted["nested"]["token"]
                .as_str()
                .unwrap()
                .contains("redacted")
        );
    }

    #[test]
    fn redaction_hides_apply_patch_documents() {
        let redacted = redact_arguments(&serde_json::json!({
            "patch": "*** Begin Patch\n*** Add File: /tmp/a.txt\n+secret\n*** End Patch"
        }));
        let patch = redacted["patch"].as_str().unwrap();
        assert!(patch.contains("redacted"));
        assert!(!patch.contains("secret"));
    }

    #[test]
    fn redaction_preserves_non_sensitive_values() {
        let redacted = redact_arguments(&serde_json::json!({"limit": 10, "recursive": true}));
        assert_eq!(redacted["limit"], 10);
        assert_eq!(redacted["recursive"], true);
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }

    #[test]
    fn timestamps_are_well_formed() {
        let stamp = now_rfc3339();
        assert!(stamp.ends_with('Z'));
        assert_eq!(stamp.len(), 24);
        assert_eq!(&stamp[4..5], "-");
    }

    #[tokio::test]
    async fn ring_buffer_keeps_the_newest_entries() {
        let log = AuditLog::in_memory();
        for index in 0..5 {
            log.record(AuditEntry {
                timestamp: now_rfc3339(),
                call_id: format!("call-{index}"),
                tool: "fs.list_dir".into(),
                arguments: serde_json::json!({}),
                outcome: AuditOutcome::Allowed,
                matched_rule: None,
                reason: None,
                duration_ms: None,
                origin: "local-test".into(),
                conversation_id: None,
            })
            .await;
        }

        let recent = log.recent(2).await;
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[1].call_id, "call-4");
    }
}
